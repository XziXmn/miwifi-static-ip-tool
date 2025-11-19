// ==UserScript==
// @name         小米路由器静态IP管理增强脚本
// @namespace    XziXmn
// @version      0.5
// @description  集成通用 AI (OpenAI 兼容 API)，支持分块并发分析 OUI 数据库，具备进度条、中断功能，并可一键下载 AI 分类结果
// @author       XziXmn
// @match        *://*/cgi-bin/luci/;stok=*/*
// @connect      standards-oui.ieee.org
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-body
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ==================== A. 配置与常量 ====================

    // 配置存储键
    const AI_API_KEY_KEY = 'ai_api_key'; // Bearer Token
    const AI_API_URL_KEY = 'ai_api_url'; // 完整的 API URL
    const AI_MODEL_ID_KEY = 'ai_model_id'; // 模型名称
    const AI_FEATURE_ENABLED_KEY = 'ai_feature_enabled';
    const AI_CONCURRENCY_KEY = 'ai_concurrency'; // 并发线程数

    const RAW_DB_KEY = 'offline_mac_db_raw'; // 原始 OUI 厂商数据库
    const AI_DB_KEY = 'offline_mac_db_ai'; // AI 分析后的分类数据库

    const MAX_PROMPT_CHARS = 80000; // 单个任务块中厂商列表的最大字符数 (保守值)

    const OUI_SOURCES = [
        { url: 'https://standards-oui.ieee.org/oui/oui.txt', type: 'MA-L', len: 6 },
        { url: 'https://standards-oui.ieee.org/oui28/mam.txt', type: 'MA-M', len: 7 },
        { url: 'https://standards-oui.ieee.org/oui36/oui36.txt', type: 'MA-S', len: 9 }
    ];

    // 全局状态
    let analysisAborted = false; // 新增：用于中断 AI 分析任务的标志

    // 全局函数
    const getToken = () => /;stok=([\da-f]{32})/.exec(location.href)?.[1] || '';
    const getApiKey = () => GM_getValue(AI_API_KEY_KEY, '');

    // 文件下载工具
    function downloadFile(content, fileName, mimeType) {
        const a = document.createElement('a');
        const blob = new Blob([content], { type: mimeType });
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }


    // ==================== B. AI 工具与数据库模块 (MacDB) ====================

    const MacDB = (function() {

        // --- 1. 原始数据下载与解析 (保持一致) ---

        function parseIEEE(text) {
            const map = {};
            const regex = /^([0-9A-F-]{8,})[\s\t]+\(hex\)[\s\t]+(.+)$/gim;
            let match;
            while ((match = regex.exec(text)) !== null) {
                let rawPrefix = match[1].replace(/-/g, '').toUpperCase();
                let vendor = match[2].trim().replace(/[\r\n]+/g, '').trim();
                if (rawPrefix && vendor) {
                    map[rawPrefix] = vendor;
                }
            }
            return map;
        }

        function download(url) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    timeout: 60000,
                    onload: (res) => {
                        if (res.status === 200) resolve(res.responseText);
                        else reject(new Error(`下载失败：HTTP ${res.status} for ${url}`));
                    },
                    onerror: reject,
                    ontimeout: () => reject(new Error(`下载超时: ${url}`)),
                });
            });
        }

        async function updateRawDB() {
            console.log('MacDB: 正在从 IEEE 下载原始 MAC 数据库...');
            alert('开始下载 OUI 原始数据库，请稍候... (这可能需要 30-60 秒)');
            let totalData = {};

            try {
                const results = await Promise.all(OUI_SOURCES.map(src =>
                    download(src.url).then(text => ({ ...src, text }))
                ));

                for (const res of results) {
                    const partMap = parseIEEE(res.text);
                    Object.assign(totalData, partMap);
                }

                const db = {
                    timestamp: Date.now(),
                    data: totalData
                };

                GM_setValue(RAW_DB_KEY, JSON.stringify(db));
                console.log(`MacDB: 原始数据库更新完成！共 ${Object.keys(totalData).length} 条记录。`);
                alert(`原始数据库下载完成！共 ${Object.keys(totalData).length} 条记录。`);
                return totalData;

            } catch (e) {
                console.error('MacDB: 原始数据库更新失败:', e.message);
                alert(`原始数据库下载失败: ${e.message}`);
                throw e;
            }
        }

        // --- 2. AI 分析核心逻辑 ---

        /**
         * 原子性地读取、合并并保存 AI 分类数据库。
         * @param {Object} newResults - 新的分析结果对象，键为厂商名。
         * @returns {number} 合并后的总记录数。
         */
        function updateAiDB(newResults) {
            const aiStr = GM_getValue(AI_DB_KEY);
            const aiDB = aiStr ? JSON.parse(aiStr) : { timestamp: 0, data: {} };

            Object.assign(aiDB.data, newResults);
            aiDB.timestamp = Date.now();

            GM_setValue(AI_DB_KEY, JSON.stringify(aiDB));
            return Object.keys(aiDB.data).length;
        }

        function callAiAnalysis(promptContent, apiKey) {
            return new Promise((resolve, reject) => {
                const apiUrl = GM_getValue(AI_API_URL_KEY, 'https://api.openai.com/v1/chat/completions');
                const modelId = GM_getValue(AI_MODEL_ID_KEY, 'gpt-3.5-turbo');
                if (!apiUrl || !modelId) { return reject(new Error("API URL 或模型 ID 未设置，请检查配置。")); }

                const requestBody = {
                    model: modelId,
                    messages: [
                        { role: "system", content: promptContent.system },
                        { role: "user", content: promptContent.user }
                    ],
                    response_format: { type: "json_object" },
                    temperature: 0.1
                };

                GM_xmlhttpRequest({
                    method: "POST",
                    url: apiUrl,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`
                    },
                    data: JSON.stringify(requestBody),
                    timeout: 90000,
                    onload: (res) => {
                        try {
                            const json = JSON.parse(res.responseText);
                            if (json.error) {
                                return reject(new Error(`AI API 错误: ${json.error.message}`));
                            }
                            const textContent = json.choices?.[0]?.message?.content;
                            if (textContent) {
                                const result = JSON.parse(textContent);
                                resolve(result);
                            } else {
                                reject(new Error("AI 响应格式错误或内容为空。"));
                            }
                        } catch (e) {
                            reject(new Error(`AI 响应解析失败: ${e.message}\n原始响应: ${res.responseText.substring(0, 300)}`));
                        }
                    },
                    onerror: reject,
                    ontimeout: () => reject(new Error("AI 调用超时。")),
                });
            });
        }

        /**
         * 执行分块并发 AI 分析，并实时更新本地数据库。
         * @param {function(number, number, number, string|null): void} updateStatusCallback - 实时更新 UI 状态的回调函数。
         * @param {function(): boolean} checkAbort - 检查中断状态的回调函数。
         */
        async function runAiAnalysis(updateStatusCallback, checkAbort) {
            const apiKey = getApiKey();
            if (!apiKey) {
                throw new Error("API Key (Bearer Token) 未设置。");
            }

            // 恢复并发控制，默认并发 3（从配置读取）
            const concurrency = Math.max(1, parseInt(GM_getValue(AI_CONCURRENCY_KEY, 3)) || 3);
            const { system, uniqueVendors } = getAiPromptParts();

            if (uniqueVendors.length === 0) {
                throw new Error("OUI 原始数据库中未找到任何厂商名称，请先更新 OUI 原始库。");
            }

            // --- 1. Chunking Logic (每20条一组，保持小块实时保存) ---
            const CHUNK_SIZE = 20;
            let chunks = [];
            for (let i = 0; i < uniqueVendors.length; i += CHUNK_SIZE) {
                chunks.push(uniqueVendors.slice(i, i + CHUNK_SIZE));
            }

            console.log(`MacDB: 总共分成 ${chunks.length} 个任务块，将以最大 ${concurrency} 并发执行。`);

            let executedTasks = 0;
            let activeTasks = 0;     // 当前正在进行的任务数
            let taskIndex = 0;

            const executeTask = async (chunkIndex, chunk) => {
                if (checkAbort()) {
                    console.log(`[任务 ${chunkIndex + 1}] 已放弃（用户中断）`);
                    return;
                }

                const userPrompt = `请分析以下厂商名称列表（任务 ${chunkIndex + 1} / ${chunks.length}）：${chunk.join(', ')}`;

                try {
                    const result = await callAiAnalysis({ system, user: userPrompt }, apiKey);

                    // 中断期间可能已返回，检查后再保存
                    if (checkAbort()) return;

                    const totalCount = updateAiDB(result);
                    executedTasks++;
                    updateStatusCallback(executedTasks, chunks.length, totalCount, null);

                    // 实时追加日志
                    const logArea = document.getElementById('analysis-log');
                    if (logArea) {
                        logArea.value += `\n\n[任务 ${chunkIndex + 1}/${chunks.length}] 返回结果:\n${JSON.stringify(result, null, 2)}`;
                        logArea.scrollTop = logArea.scrollHeight;
                    }
                } catch (e) {
                    executedTasks++;
                    updateStatusCallback(executedTasks, chunks.length, null, e.message);
                    console.error(`[任务 ${chunkIndex + 1} 失败]`, e.message);

                    const logArea = document.getElementById('analysis-log');
                    if (logArea) {
                        logArea.value += `\n\n[任务 ${chunkIndex + 1}/${chunks.length}] 失败: ${e.message}`;
                        logArea.scrollTop = logArea.scrollHeight;
                    }
                } finally {
                    activeTasks--;
                }
            };

            // --- 2. 精确并发调度器（支持中断）---
            const scheduler = async () => {
                while (taskIndex < chunks.length) {
                    if (checkAbort()) break;

                    // 启动新任务直到达到并发上限
                    while (activeTasks < concurrency && taskIndex < chunks.length) {
                        const idx = taskIndex++;
                        const chunk = chunks[idx];
                        activeTasks++;
                        executeTask(idx, chunk).finally(() => {
                            // 任务结束后自动触发下一轮（如果还有）
                            if (!checkAbort() && taskIndex < chunks.length) {
                                scheduler(); // 递归触发下一批
                            }
                        });
                    }

                    // 等待任意一个任务完成再继续派发
                    await new Promise(resolve => setTimeout(resolve, 100)); // 轻量轮询
                }
            };

            // 启动调度
            await scheduler();

            // 等待所有已派发的任务完成
            while (activeTasks > 0) {
                if (checkAbort()) break;
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            // --- 3. 结果和通知 ---
            const finalCount = Object.keys(JSON.parse(GM_getValue(AI_DB_KEY, '{}')).data || {}).length;

            if (checkAbort()) {
                updateStatusCallback(executedTasks, chunks.length, finalCount, "任务已中断");
                alert("AI 分析任务已被用户中断。已完成的任务结果已保存。");
            } else if (finalCount === 0) {
                throw new Error("所有 AI 分析任务失败或返回空结果。");
            } else {
                updateStatusCallback(executedTasks, chunks.length, finalCount, null);
                alert(`AI 分析完成！总共缓存 ${finalCount} 条分类结果。`);
            }

            return finalCount;
        }

        // --- 3. 数据库操作接口 (保持一致) ---
        // ... (exportRawDB, importAiDB, getAiPromptParts, lookup functions remain the same)

        function exportRawDB() {
            const rawStr = GM_getValue(RAW_DB_KEY);
            if (!rawStr) {
                alert("OUI 原始数据库缺失，请先点击更新 OUI 库。");
                return;
            }
            const rawDB = JSON.parse(rawStr);
            const content = JSON.stringify(rawDB.data, null, 2);
            downloadFile(content, `oui_raw_db_${new Date(rawDB.timestamp).getTime()}.json`, 'application/json');
        }

        async function importAiDB(file) {
             return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    try {
                        const text = e.target.result;
                        let data;
                        try {
                            data = JSON.parse(text);
                        } catch (jsonError) {
                            const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
                            if (jsonMatch && jsonMatch[1]) {
                                data = JSON.parse(jsonMatch[1]);
                            } else {
                                throw new Error("文件内容无法解析为有效的 JSON 格式。");
                            }
                        }

                        let validCount = 0;
                        for (const key in data) {
                            if (data[key] && typeof data[key] === 'object' && data[key].category && data[key].description_cn) {
                                validCount++;
                            }
                        }

                        if (validCount === 0) {
                            throw new Error("解析成功但未找到符合预期的厂商分类结构，请检查格式是否为 {'厂商名称': {'category': '...', 'description_cn': '...'}}");
                        }

                        const aiDB = {
                            timestamp: Date.now(),
                            data: data
                        };
                        GM_setValue(AI_DB_KEY, JSON.stringify(aiDB));
                        resolve(validCount);
                    } catch (e) {
                        reject(e);
                    }
                };
                reader.onerror = reject;
                reader.readAsText(file);
            });
        }

        function getAiPromptParts() {
            const rawStr = GM_getValue(RAW_DB_KEY);
            const rawDB = rawStr ? JSON.parse(rawStr).data : {};
            const allVendors = Object.values(rawDB);
            const uniqueVendors = Array.from(new Set(allVendors));

            const systemPrompt = `你是一个专业的网络设备厂商分类专家。请根据以下提供的原始 MAC 地址 OUI 厂商名称列表，对每个厂商进行精确的行业分类，并提供简短的中文描述。

分类标签（category）必须严格从以下枚举中选择：MOBILE/PC/IOT/NETWORK/VM/OTHER。

请严格以 JSON 格式返回结果，不包含任何额外说明或Markdown包裹。
JSON 结构必须是：
{
    "厂商名称": {
        "category": "分类标签 (MOBILE/PC/IOT/NETWORK/VM/OTHER)",
        "description_cn": "简短的中文描述"
    }
}`;

            return {
                system: systemPrompt,
                uniqueVendors: uniqueVendors,
                totalVendors: Object.keys(rawDB).length
            };
        }

        function lookup(mac) {
            const cleanMac = mac.replace(/[:\-\.]/g, '').toUpperCase();
            if (cleanMac.length < 6) return { vendor: '未知厂商', aiCategory: null };

            const rawStr = GM_getValue(RAW_DB_KEY);
            if (!rawStr) return { vendor: '未知厂商 (OUI库缺失)', aiCategory: null };

            const rawDB = JSON.parse(rawStr).data;
            const aiStr = GM_getValue(AI_DB_KEY);
            const aiDB = aiStr ? JSON.parse(aiStr).data : {};

            let vendorName = null;

            const prefixes = [
                cleanMac.substring(0, 9),
                cleanMac.substring(0, 7),
                cleanMac.substring(0, 6)
            ];

            for (const prefix of prefixes) {
                if (rawDB[prefix]) {
                    vendorName = rawDB[prefix];
                    break;
                }
            }

            if (!vendorName) return { vendor: '未知厂商 (DB)', aiCategory: null };

            const aiEnabled = GM_getValue(AI_FEATURE_ENABLED_KEY, false);
            const aiResult = aiEnabled ? aiDB[vendorName] : null;

            return {
                vendor: vendorName + ' (DB)',
                aiCategory: aiResult
            };
        }

        async function init() {
            // 保持空白，只在用户手动点击时启动分析
        }

        init();

        return { lookup, updateRawDB, runAiAnalysis, exportRawDB, importAiDB, getAiPromptParts };
    })();

    // ==================== C. 设备分类配置与逻辑 (保持一致) ====================
    // ... (CATEGORY_MAP, MANUAL_KEYWORDS, getCategory, identifyDevice functions remain the same)

    const CATEGORY_MAP = {
        'MOBILE': { label: '手机/平板', color: '#10b981', sort: 30 },
        'PC': { label: '个人电脑', color: '#0ea5e9', sort: 20 },
        'NETWORK': { label: '网络设备', color: '#f59e0b', sort: 40 },
        'IOT': { label: '智能家居', color: '#f97316', sort: 50 },
        'VM': { label: '虚拟机', color: '#8b5cf6', sort: 10 },
        'REPO': { label: '仓库/服务器', color: '#06b6d4', sort: 60 },
        'OTHER': { label: '其他', color: '#9ca3af', sort: 99 }
    };

    const MANUAL_KEYWORDS = {
        'VM': /VMWARE|VIRTUALBOX|XENSOURCE|HYPER-V|MICROSOFT CORP/,
        'PC': /^(YM-|YM|YMAE|YMGOODS)|WIN-|DESKTOP-|PC-|LAPTOP-|MINIP/
    };

    function getCategory(type) {
        return CATEGORY_MAP[type] || CATEGORY_MAP['OTHER'];
    }

    function identifyDevice(item) {
        const name = (item.name || '').toUpperCase();
        const vendor = (item.vendor || '').toUpperCase().replace(' (DB)', '');
        const { aiCategory } = MacDB.lookup(item.mac);

        if (aiCategory && CATEGORY_MAP[aiCategory.category]) {
            const type = aiCategory.category;
            const category = getCategory(type);
            return {
                type: type,
                label: category.label,
                color: category.color,
                sort: category.sort,
                aiDescription: aiCategory.description_cn
            };
        }

        for (const [type, regex] of Object.entries(MANUAL_KEYWORDS)) {
            if (regex.test(vendor) || regex.test(name)) {
                return { type: type, ...getCategory(type), aiDescription: null };
            }
        }

        if (name.startsWith('CK')) return { type: 'REPO', ...getCategory('REPO'), aiDescription: null };
        if (/IPHONE|ANDROID|OPPO|VIVO|HUAWEI|XIAOMI|REDMI|MI|SAMSUNG|IPAD|TABLET|WATCH/.test(name))
            return { type: 'MOBILE', ...getCategory('MOBILE'), aiDescription: null };
        if (/CAM|PLUG|LIGHT|BOX|TV|MIOT|TUYA|ESP|ROUTER|AP|PRINTER|NAS/.test(name))
            return { type: 'IOT', ...getCategory('IOT'), aiDescription: null };

        return { type: 'OTHER', ...getCategory('OTHER'), aiDescription: null };
    }

    // ==================== D. 样式和 UI 渲染 ====================

    const fix = document.createElement('style');
    fix.textContent = `html, body, #doc, #bd, .inner, .mod-set-nav { overflow: visible !important; height: auto !important; }`;
    document.head.appendChild(fix);

    const style = document.createElement('style');
    style.textContent = `
        .static-ip-fab {
            position: fixed; right: 20px; bottom: 20px; z-index: 9999;
            font-family: system-ui, -apple-system, sans-serif; display:flex; flex-direction:column; align-items:flex-end;
        }
        .static-ip-btn, .static-ip-fab-btn-settings {
            display: flex; align-items: center; justify-content: center;
            height: 48px; margin-top: 12px; border-radius: 24px;
            font-size: 15px; font-weight: 600; color: white; cursor: pointer;
            box-shadow: 0 0 12px rgba(0,0,0,0.1); transition: transform 0.2s; user-select: none;
        }
        .static-ip-fab-btn-settings {
            background: #4b5563;
            width: 48px;
            border-radius: 50%;
            font-size: 20px;
        }
        .static-ip-fab-btn-settings:active { transform: scale(0.95); }
        .static-ip-btn { width: 120px; }
        .static-ip-btn:active { transform: scale(0.95); }
        .static-ip-add { background: linear-gradient(135deg, #ff9500, #ff5e00); }
        .static-ip-del { background: linear-gradient(135deg, #ff4d4f, #f5222d); }

        .static-ip-modal {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.6); z-index: 2000;
            display: none; align-items: center; justify-content: center;
        }
        .static-ip-panel {
            width: 90%; max-width: 650px; height: 85vh; background: #fff;
            border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 12px 48px rgba(0,0,0,0.2); animation: popIn 0.2s ease-out;
        }
        @keyframes popIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }

        .static-ip-header { padding: 16px 24px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
        .static-ip-title { font-size: 18px; font-weight: 700; color: #111827; }
        .static-ip-close { font-size: 28px; color: #9ca3af; cursor: pointer; line-height: 1; }

        /* Settings Panel specific styles */
        .settings-panel-body { flex: 1; overflow-y: auto; padding: 24px; background: #fff; }
        .settings-content-group { margin-bottom: 25px; padding: 15px; border: 1px solid #e5e7eb; border-radius: 8px; }
        .settings-content-group h4 { margin-top: 0; margin-bottom: 12px; font-size: 16px; color: #1f2937; font-weight: 600; }
        .settings-content-group input[type="text"], .settings-content-group textarea {
            width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px;
            box-sizing: border-box; font-family: monospace;
        }
        .settings-content-group input[type="number"] {
             width: 80px; padding: 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px;
        }
        .settings-content-group label { display: flex; align-items: center; font-size: 14px; margin-bottom: 8px; cursor: pointer; }
        .settings-content-group input[type="checkbox"] { margin-right: 10px; accent-color: #ff6600; }
        .settings-content-group button {
            background: #f97316; color: white; padding: 10px 15px; border: none; border-radius: 4px;
            cursor: pointer; font-size: 14px; margin-top: 10px; font-weight: 600;
        }
        .settings-content-group button:disabled { background: #9ca3af; cursor: not-allowed; }
        .settings-status-indicator { margin-top: 10px; font-size: 12px; color: #6b7280; }

        /* Progress Bar Styles */
        .analysis-progress-container {
            width: 100%; height: 20px; background: #e5e7eb; border-radius: 4px; overflow: hidden; margin-top: 10px;
        }
        .analysis-progress-bar {
            height: 100%; width: 0%; background: #22c55e; transition: width 0.3s;
            display: flex; align-items: center; justify-content: center; color: white; font-size: 10px; font-weight: bold;
        }
        .btn-stop { background: #ef4444 !important; } /* 中断按钮颜色 */

        /* 新增日志框样式 */
        #analysis-log {
            width: 100%; height: 150px; margin-top: 10px; padding: 10px; border: 1px solid #d1d5db;
            border-radius: 4px; font-family: monospace; font-size: 12px; overflow-y: auto; background: #f9fafb;
            white-space: pre-wrap; word-wrap: break-word;
        }

        /* List styles (remaining styles are unchanged) */
        .static-ip-body { flex: 1; overflow-y: auto; background: #fff; }
        .static-ip-group-header {
            padding: 12px 24px; background: #f3f4f6; color: #4b5563; font-size: 13px; font-weight: 600;
            border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; z-index: 10;
            display: flex; justify-content: space-between;
        }
        .static-ip-item { display: flex; align-items: center; padding: 12px 24px; border-bottom: 1px solid #f3f4f6; cursor: pointer; }
        .static-ip-item:hover { background: #f9fafb; }
        .static-ip-item:has(input:checked) { background: #fff7ed; }
        .static-ip-del .static-ip-item:has(input:checked) { background: #fef2f2; }
        .static-ip-checkbox { width: 20px; height: 20px; margin-right: 16px; flex-shrink: 0; accent-color: #ff6600; cursor: pointer; }

        .item-content { flex: 1; min-width: 0; }
        .item-header { display: flex; align-items: center; margin-bottom: 4px; gap: 8px; }
        .item-name { font-size: 15px; font-weight: 600; color: #1f2937; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .item-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; color: #fff; font-weight: normal; flex-shrink: 0; }
        .item-vendor { font-size: 12px; color: #6b7280; background: #f3f4f6; padding: 1px 6px; border-radius: 4px; }

        .item-details { display: flex; gap: 12px; font-family: Menlo, Monaco, monospace; font-size: 13px; color: #6b7280; }
        .item-ip { color: #ea580c; background: #ffedd5; padding: 0 4px; border-radius: 2px; }
        .item-ai-desc { font-size: 12px; color: #4b5563; margin-left: auto; font-family: system-ui; font-style: italic; max-width: 40%; text-align: right;}

        .static-ip-footer { padding: 16px 24px; border-top: 1px solid #e5e7eb; background: #fff; display: flex; justify-content: space-between; align-items: center; }
        .action-btn { padding: 10px 28px; border-radius: 24px; border: none; color: #fff; font-weight: 600; cursor: pointer; font-size: 14px; }
        .btn-add { background: #f97316; }
        .btn-del { background: #ef4444; }
        .action-btn:disabled { opacity: 0.5; cursor: not-allowed; background: #9ca3af; }
        .static-ip-textarea { display: block; width: calc(100% - 48px); margin: 16px 24px; height: 100px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; }
        .loading-tip { text-align: center; padding: 60px 0; color: #9ca3af; }
    `;
    document.head.appendChild(style);

    // ==================== E. 渲染与提交逻辑 ====================

    function processList(rawList) {
        return rawList.map(item => {
            const processed = {
                mac: item.mac.toUpperCase(),
                ip: item.ip,
                name: item.name || item.origin_name || '未知设备'
            };

            const lookupResult = MacDB.lookup(processed.mac);
            processed.vendor = lookupResult.vendor;

            const category = identifyDevice({ ...processed, aiCategory: lookupResult.aiCategory });

            return { ...processed, ...category };
        }).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
    }

    // --- 1. 设备管理 Modal (添加/删除 - 保持一致) ---
    // ... (renderManagementModal remains the same)
    function renderManagementModal(mode) {
        const isAdd = mode === 'add';
        const id = isAdd ? 'add' : 'del';

        const modal = document.createElement('div');
        modal.className = 'static-ip-modal';
        modal.innerHTML = `
            <div class="static-ip-panel ${isAdd ? 'static-ip-add' : 'static-ip-del'}">
                <div class="static-ip-header">
                    <div class="static-ip-title">${isAdd ? '添加静态IP绑定' : '删除静态IP绑定'}</div>
                    <div class="static-ip-close">×</div>
                </div>
                <div class="static-ip-body">
                    <div class="static-ip-group-header">
                        <span>${isAdd ? '未绑定设备' : '已绑定设备'}</span>
                        <span id="status-${id}" style="font-weight:normal;font-size:12px">读取中...</span>
                    </div>
                    <div class="static-ip-list" id="list-${id}"></div>
                    ${isAdd ? `<textarea class="static-ip-textarea" id="textarea-${id}" placeholder="手动输入（每行一个）：MAC IP 备注\n例如: 00:1A:2B:3C:4D:5E 192.168.31.200 我的电脑"></textarea>` : ''}
                </div>
                <div class="static-ip-footer">
                    <label style="cursor:pointer;display:flex;align-items:center;font-size:14px">
                        <input type="checkbox" id="select-all-${id}" style="margin-right:8px"> 全选
                    </label>
                    <button class="action-btn btn-${id}" id="submit-${id}">${isAdd ? '确认添加' : '删除所选'}</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const ui = {
            modal, list: modal.querySelector(`#list-${id}`), status: modal.querySelector(`#status-${id}`),
            close: modal.querySelector('.static-ip-close'), submit: modal.querySelector(`#submit-${id}`),
            selectAll: modal.querySelector(`#select-all-${id}`), textarea: modal.querySelector(`#textarea-${id}`)
        };

        ui.close.onclick = () => modal.style.display = 'none';
        ui.modal.onclick = e => { if(e.target === modal) modal.style.display = 'none'; };

        const renderItem = (item) => {
            const vendorHtml = `<span class="item-vendor">${item.vendor}</span>`;
            const aiDescHtml = item.aiDescription ? `<span class="item-ai-desc">${item.aiDescription}</span>` : '';
            return `
                <label class="static-ip-item">
                    <input type="checkbox" class="static-ip-checkbox" value='${JSON.stringify({mac:item.mac, ip:item.ip, name:item.name})}'>
                    <div class="item-content">
                        <div class="item-header">
                            <span class="item-name">${item.name}</span>
                            <span class="item-tag" style="background:${item.color}">${item.label}</span>
                        </div>
                        <div class="item-details">
                            <span class="item-mac">${item.mac}</span>
                            <span>→</span>
                            <span class="item-ip">${item.ip}</span>
                            ${vendorHtml}
                            ${aiDescHtml}
                        </div>
                    </div>
                </label>
            `;
        };

        ui.load = async () => {
            ui.list.innerHTML = '<div class="loading-tip">加载数据中...</div>';
            try {
                const r = await fetch(`/cgi-bin/luci/;stok=${getToken()}/api/xqnetwork/macbind_info`);
                const data = await r.json();

                let items = isAdd ? (data.devicelist || []).filter(d => d.tag !== 2) : (data.list || []);
                items = processList(items);

                ui.status.innerText = `共 ${items.length} 台`;
                ui.list.innerHTML = items.length ? items.map(renderItem).join('') : '<div class="loading-tip">无数据</div>';
            } catch(e) {
                ui.list.innerHTML = '<div class="loading-tip">数据加载失败</div>';
            }

            ui.selectAll.checked = false;
            ui.selectAll.onchange = () => {
                ui.list.querySelectorAll('.static-ip-checkbox').forEach(cb => cb.checked = ui.selectAll.checked);
            };
        };

        ui.submit.onclick = async () => {
            const checked = [...ui.list.querySelectorAll('.static-ip-checkbox:checked')].map(c => JSON.parse(c.value));

            let items = checked;

            if (isAdd && ui.textarea && ui.textarea.value.trim()) {
                const manual = ui.textarea.value.split('\n').map(l => {
                    const parts = l.trim().split(/\s+/);
                    if (parts.length < 2) return null;
                    const mac = parts[0].match(/([0-9A-F]{2}[:-]){5}([0-9A-F]{2})/i)?.[0];
                    const ip = parts[1].match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)?.[0];
                    const name = parts.slice(2).join(' ') || '手动添加';
                    return (mac && ip) ? {mac: mac.toUpperCase(), ip: ip, name: name} : null;
                }).filter(Boolean);
                items = [...items, ...manual];
            }

            if (!items.length) return alert('请至少选择或输入一项');
            if (!isAdd && !confirm(`确定删除 ${items.length} 项？`)) return;

            ui.submit.disabled = true;
            ui.submit.innerText = '执行中...';
            const stok = getToken();

            for (const item of items) {
                const api = isAdd ? 'mac_bind' : 'mac_unbind';
                const body = isAdd ? `data=${encodeURIComponent(JSON.stringify([item]))}` : `mac=${item.mac}`;
                await fetch(`/cgi-bin/luci/;stok=${stok}/api/xqnetwork/${api}`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body
                }).catch(e => console.error(`API 错误 for ${item.mac}:`, e));
            }
            alert('操作完成！页面即将刷新');
            location.reload();
        };

        return ui;
    }


    // --- 2. 设置 Modal ---

    function renderSettingsModal() {
        const modal = document.createElement('div');
        modal.className = 'static-ip-modal';
        modal.id = 'settings-modal';
        modal.innerHTML = `
            <div class="static-ip-panel static-ip-settings">
                <div class="static-ip-header">
                    <div class="static-ip-title">⚙️ AI 厂商分类通用设置 (${GM_info.script.version})</div>
                    <div class="static-ip-close">×</div>
                </div>
                <div class="static-ip-body settings-panel-body">
                    <div class="settings-content-group">
                        <h4>AI 功能开关</h4>
                        <label>
                            <input type="checkbox" id="ai-enabled-toggle"> 启用 AI 厂商分类 (不启用则跳过所有 AI 调用)
                        </label>
                        <div class="settings-status-indicator">启用后，脚本将使用 AI 分析 OUI 厂商并进行更精确的中文分类。</div>
                    </div>

                    <div class="settings-content-group">
                        <h4>并发线程数</h4>
                        <input type="number" id="concurrency-input" min="1" max="10" placeholder="例如: 3" value="${GM_getValue(AI_CONCURRENCY_KEY, 3)}">
                        <div class="settings-status-indicator">同时向 AI 服务发送的请求数量（默认 3）。过高可能导致 API 速率限制。</div>
                    </div>

                    <div class="settings-content-group">
                        <h4>API Key (Bearer Token)</h4>
                        <input type="text" id="api-key-input" placeholder="输入您的 OpenAI/通用 API Key (通常以 sk- 或类似前缀开头)">
                        <div class="settings-status-indicator" id="key-status-indicator"></div>
                    </div>

                    <div class="settings-content-group">
                        <h4>OpenAI 兼容 API URL</h4>
                        <input type="text" id="api-url-input" placeholder="例如: https://api.openai.com/v1/chat/completions">
                        <div class="settings-status-indicator">必须是完整的 Chat Completions API 地址。</div>
                    </div>

                    <div class="settings-content-group">
                        <h4>模型 ID (Model ID)</h4>
                        <input type="text" id="model-id-input" placeholder="例如: gpt-3.5-turbo 或 llama-3-8b-chat">
                        <div class="settings-status-indicator">用于指定您要使用的 AI 模型。</div>
                    </div>

                    <div class="settings-content-group">
                        <h4>AI 分析提示词 (Prompt)</h4>
                        <textarea id="ai-prompt-display" rows="8" readonly style="resize:vertical; font-size:12px; height: 120px;"></textarea>
                        <button id="copy-prompt-btn" style="margin-top: 5px; background: #6366f1;">复制提示词到剪贴板</button>
                        <div class="settings-status-indicator" style="margin-top: 5px;">本提示词仅包含**系统指令**和**厂商样本**，您可以将其复制到外部 AI 工具中运行，然后将结果上传。</div>
                    </div>

                    <div class="settings-content-group">
                        <h4>数据库状态与操作</h4>
                        <div class="settings-status-indicator" id="db-raw-status"></div>
                        <div class="settings-status-indicator" id="db-ai-status"></div>

                        <div class="analysis-progress-container" id="analysis-progress-container" style="display:none;">
                            <div class="analysis-progress-bar" id="analysis-progress-bar">0%</div>
                        </div>

                        <div style="display:flex; gap: 10px; margin-top: 15px; flex-wrap: wrap;">
                            <button id="update-oui-btn" style="background: #3b82f6; flex-grow: 1;">立即检查并更新 OUI 原始库</button>
                            <button id="download-oui-btn" style="background: #0ea5e9; flex-grow: 1;">下载 OUI 原始库 (JSON)</button>
                        </div>

                        <button id="download-ai-db-btn" style="margin-top: 10px; width: 100%; background: #8b5cf6;">下载 AI 分类数据库 (JSON)</button>

                        <button id="run-ai-analysis-btn" style="margin-top: 10px; width: 100%;">保存配置并执行 AI 厂商分块并发分析</button>
                        <div class="settings-status-indicator">（此操作需要有效的 API 配置。分块并发执行，实时保存结果。）</div>

                        <!-- 新增临时日志框 -->
                        <textarea id="analysis-log" readonly placeholder="API 返回日志将显示在这里..."></textarea>
                    </div>

                    <div class="settings-content-group">
                        <h4>上传 AI 分类结果 (跳过分析)</h4>
                        <input type="file" id="ai-db-upload-input" accept=".json,.txt" style="margin-bottom: 10px; padding: 5px 0;">
                        <button id="upload-ai-db-btn" disabled style="background: #059669;">上传并应用</button>
                        <div class="settings-status-indicator">支持 JSON 或包含 JSON 代码块的 TXT 文件。上传后分类结果会立即生效。</div>
                    </div>

                </div>
                <div class="static-ip-footer">
                    <button class="action-btn" id="save-settings-btn" style="background:#0ea5e9">仅保存配置</button>
                    <button class="action-btn" style="background:#4b5563" onclick="document.getElementById('settings-modal').style.display='none'">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const ui = {
            modal, close: modal.querySelector('.static-ip-close'), saveBtn: modal.querySelector('#save-settings-btn'),
            apiKeyInput: modal.querySelector('#api-key-input'), aiToggle: modal.querySelector('#ai-enabled-toggle'),
            apiUrlInput: modal.querySelector('#api-url-input'), modelIdInput: modal.querySelector('#model-id-input'),
            concurrencyInput: modal.querySelector('#concurrency-input'),
            keyStatus: modal.querySelector('#key-status-indicator'), dbRawStatus: modal.querySelector('#db-raw-status'),
            dbAiStatus: modal.querySelector('#db-ai-status'), runAiBtn: modal.querySelector('#run-ai-analysis-btn'),
            aiPromptDisplay: modal.querySelector('#ai-prompt-display'), copyPromptBtn: modal.querySelector('#copy-prompt-btn'),
            downloadOuiBtn: modal.querySelector('#download-oui-btn'), updateOuiBtn: modal.querySelector('#update-oui-btn'),
            aiDbUploadInput: modal.querySelector('#ai-db-upload-input'), uploadAiDbBtn: modal.querySelector('#upload-ai-db-btn'),
            // NEW Progress Bar elements
            progressContainer: modal.querySelector('#analysis-progress-container'),
            progressBar: modal.querySelector('#analysis-progress-bar'),
            downloadAiDbBtn: modal.querySelector('#download-ai-db-btn')
        };

        // Function to refresh database status display
        const refreshStatus = () => {
            const currentKey = GM_getValue(AI_API_KEY_KEY, '');
            const currentUrl = GM_getValue(AI_API_URL_KEY, 'https://api.openai.com/v1/chat/completions');
            const currentModel = GM_getValue(AI_MODEL_ID_KEY, 'gpt-3.5-turbo');
            const currentConcurrency = GM_getValue(AI_CONCURRENCY_KEY, 3);
            const enabled = GM_getValue(AI_FEATURE_ENABLED_KEY, false);

            ui.apiKeyInput.value = currentKey;
            ui.apiUrlInput.value = currentUrl;
            ui.modelIdInput.value = currentModel;
            ui.aiToggle.checked = enabled;
            ui.concurrencyInput.value = currentConcurrency;

            const rawDB = JSON.parse(GM_getValue(RAW_DB_KEY, '{}'));
            const aiDB = JSON.parse(GM_getValue(AI_DB_KEY, '{}'));
            const rawCount = Object.keys(rawDB.data || {}).length;
            const aiCount = Object.keys(aiDB.data || {}).length;
            const modelText = currentModel || '（未设置）';

            ui.keyStatus.textContent = currentKey ? `当前 Key 已保存 (${currentKey.substring(0, 5)}...)` : 'Key 未设置。';
            ui.dbRawStatus.textContent = rawCount > 0 ? `OUI 原始库：${rawCount} 条记录 (${new Date(rawDB.timestamp).toLocaleDateString()})` : 'OUI 原始库：未下载/缺失。';
            ui.dbAiStatus.textContent = aiCount > 0 ? `AI 分类库：${aiCount} 条记录 (模型: ${modelText}, ${new Date(aiDB.timestamp).toLocaleDateString()})` : `AI 分类库：未分析 (模型: ${modelText})。`;

            // AI Prompt
            const promptContent = MacDB.getAiPromptParts();
            const sampleVendors = promptContent.uniqueVendors.slice(0, 300);
            const promptText = `--- System Prompt ---\n${promptContent.system}\n\n--- User Prompt (前 300 样本) ---\n请分析以下厂商名称列表（总计 ${promptContent.uniqueVendors.length} 个唯一厂商）：\n${sampleVendors.join(', ')}\n\n(提示: 复制后，您可能需要手动分块以适应外部工具的上下文限制)`;
            ui.aiPromptDisplay.value = promptText;

            // Button states
            const canRunAi = currentKey && enabled && currentUrl && currentModel && rawCount > 0 && currentConcurrency > 0;
            ui.runAiBtn.disabled = !canRunAi;
            ui.downloadOuiBtn.disabled = rawCount === 0;

            const file = ui.aiDbUploadInput.files[0];
            ui.uploadAiDbBtn.disabled = !file;

            // Reset UI for progress bar
            ui.progressContainer.style.display = 'none';
            ui.runAiBtn.classList.remove('btn-stop');
            ui.runAiBtn.disabled = !canRunAi;
            ui.updateOuiBtn.disabled = false;
            ui.downloadOuiBtn.disabled = rawCount === 0;
            ui.saveBtn.disabled = false;

            ui.downloadAiDbBtn.disabled = aiCount === 0;
            ui.downloadAiDbBtn.textContent = aiCount > 0 
                ? `下载 AI 分类数据库 (JSON) - ${aiCount} 条` 
                : `下载 AI 分类数据库 (JSON) - 暂无数据`;
        };

        // Function to save all settings
        const saveSettings = () => {
            const newKey = ui.apiKeyInput.value.trim();
            const newUrl = ui.apiUrlInput.value.trim();
            const newModel = ui.modelIdInput.value.trim();
            const newEnabled = ui.aiToggle.checked;
            const newConcurrency = Math.max(1, Math.min(10, parseInt(ui.concurrencyInput.value.trim()) || 3));

            GM_setValue(AI_API_KEY_KEY, newKey);
            GM_setValue(AI_API_URL_KEY, newUrl);
            GM_setValue(AI_MODEL_ID_KEY, newModel);
            GM_setValue(AI_FEATURE_ENABLED_KEY, newEnabled);
            GM_setValue(AI_CONCURRENCY_KEY, newConcurrency);

            refreshStatus();
            return { newKey, newUrl, newModel, newEnabled, newConcurrency };
        };

        // --- Event Handlers ---

        ui.aiDbUploadInput.onchange = refreshStatus;

        ui.close.onclick = () => modal.style.display = 'none';
        ui.modal.onclick = e => { if(e.target === modal) modal.style.display = 'none'; };
        ui.saveBtn.onclick = () => { saveSettings(); alert('配置已保存！'); };
        ui.downloadOuiBtn.onclick = () => MacDB.exportRawDB();

        ui.copyPromptBtn.onclick = () => {
            navigator.clipboard.writeText(ui.aiPromptDisplay.value).then(() => {
                ui.copyPromptBtn.textContent = '已复制！';
                setTimeout(() => ui.copyPromptBtn.textContent = '复制提示词到剪贴板', 2000);
            }, () => {
                alert('复制失败，请手动选择复制文本框内容。');
            });
        };

        ui.updateOuiBtn.onclick = async () => {
            ui.updateOuiBtn.disabled = true;
            ui.updateOuiBtn.textContent = '下载中...';
            try {
                await MacDB.updateRawDB();
            } catch (e) {
                // error alert handled inside updateRawDB
            } finally {
                refreshStatus();
                ui.updateOuiBtn.textContent = '立即检查并更新 OUI 原始库';
                ui.updateOuiBtn.disabled = false;
            }
        };

        ui.runAiBtn.onclick = async () => {
            const originalText = ui.runAiBtn.textContent;
            saveSettings();

            if (ui.runAiBtn.disabled) {
                alert("无法执行分析：请检查 Key/API URL/Model ID/并发数 是否填写完整，以及 AI 功能是否启用！");
                return;
            }

            // 1. Setup UI for analysis (变为中断按钮)
            analysisAborted = false; // 重置中断标志
            ui.runAiBtn.disabled = false;
            ui.runAiBtn.classList.add('btn-stop');
            ui.runAiBtn.textContent = '❌ 中断任务';
            ui.progressContainer.style.display = 'block';
            ui.progressBar.style.width = '0%';
            ui.progressBar.textContent = '0%';

            // 新增：清空日志框
            const logArea = document.getElementById('analysis-log');
            if (logArea) logArea.value = '';

            // 禁用其他操作按钮
            ui.updateOuiBtn.disabled = true;
            ui.downloadOuiBtn.disabled = true;
            ui.uploadAiDbBtn.disabled = true;
            ui.saveBtn.disabled = true;

            // 中断逻辑：点击按钮设置中断标志
            const stopHandler = () => {
                analysisAborted = true;
                ui.runAiBtn.disabled = true;
                ui.runAiBtn.textContent = '正在等待任务中断...';
                ui.runAiBtn.removeEventListener('click', stopHandler);
            };
            ui.runAiBtn.addEventListener('click', stopHandler);

            // 2. Real-time status update function
            const updateStatus = (current, total, savedCount, errorMessage) => {
                 const percentage = Math.round((current / total) * 100);
                 const statusText = `(${current}/${total}) - 已保存 ${savedCount} 条`;

                 ui.progressBar.style.width = `${percentage}%`;
                 ui.progressBar.textContent = `${percentage}% ${statusText}`;

                 if (errorMessage === "任务已中断") {
                    ui.dbAiStatus.textContent = `AI 分类库：已中断。已保存 ${savedCount} 条记录。`;
                 } else if (errorMessage) {
                    ui.dbAiStatus.textContent = `AI 分类库：任务 [${current}/${total}] 失败 (错误)。已保存 ${savedCount} 条记录。`;
                 } else {
                    ui.dbAiStatus.textContent = `AI 分类库：正在分析... [${current}/${total}]，已保存 ${savedCount} 条记录。`;
                 }
            };

            try {
                // 确保原始库已下载
                const rawStr = GM_getValue(RAW_DB_KEY);
                let rawDBData = rawStr ? JSON.parse(rawStr).data : null;
                if (!rawDBData || Object.keys(rawDBData).length === 0) {
                    rawDBData = await MacDB.updateRawDB().catch(() => null);
                    if (!rawDBData || Object.keys(rawDBData).length === 0) throw new Error("下载 OUI 原始库失败，无法进行 AI 分析。");
                }

                await MacDB.runAiAnalysis(updateStatus, () => analysisAborted);

            } catch (e) {
                console.error('AI 分析失败 (来自 UI 触发):', e);
                alert(`AI 分析失败: ${e.message}`);
            } finally {
                // 3. Reset UI state
                ui.runAiBtn.removeEventListener('click', stopHandler);

                // 刷新状态，这会处理所有按钮的恢复和进度条的隐藏
                refreshStatus();
            }
        };

        ui.uploadAiDbBtn.onclick = async () => {
            const file = ui.aiDbUploadInput.files[0];
            if (!file) return alert('请先选择要上传的文件！');

            ui.uploadAiDbBtn.disabled = true;
            ui.uploadAiDbBtn.textContent = '上传中...';

            try {
                const count = await MacDB.importAiDB(file);
                alert(`AI 分类数据库上传成功！已导入 ${count} 条分类结果。页面即将刷新。`);
                location.reload();
            } catch (e) {
                alert(`AI 分类数据库上传失败: ${e.message}`);
                console.error('AI DB Import Error:', e);
            } finally {
                ui.uploadAiDbBtn.disabled = false;
                ui.uploadAiDbBtn.textContent = '上传并应用';
            }
        };

        ui.downloadAiDbBtn.onclick = () => {
            const aiStr = GM_getValue(AI_DB_KEY);
            if (!aiStr) {
                alert("AI 分类数据库为空，请先完成 AI 分析或上传数据库");
                return;
            }
            const aiDB = JSON.parse(aiStr);
            if (!aiDB.data || Object.keys(aiDB.data).length === 0) {
                alert("AI 分类数据库为空");
                return;
            }
            const content = JSON.stringify(aiDB.data, null, 2);
            const timestamp = aiDB.timestamp ? new Date(aiDB.timestamp).getTime() : Date.now();
            downloadFile(content, `xiaomi_ai_vendor_db_${timestamp}.json`, 'application/json');
            alert(`AI 分类数据库下载完成！共 ${Object.keys(aiDB.data).length} 条记录`);
        };

        // Initial Load
        refreshStatus();

        return modal;
    }

    // ==================== F. 启动 (保持一致) ====================
    function initButtons() {
        let fab = document.querySelector('.static-ip-fab');
        if (!fab) { fab = document.createElement('div'); fab.className = 'static-ip-fab'; document.body.appendChild(fab); }

        // 1. Settings Button
        if (!document.getElementById('btn-settings')) {
            const btn = document.createElement('div');
            btn.id = 'btn-settings';
            btn.className = 'static-ip-fab-btn-settings';
            btn.innerHTML = '⚙️';
            fab.appendChild(btn);

            const settingsModal = renderSettingsModal();
            btn.onclick = () => settingsModal.style.display = 'flex';
        }

        // 2. Add Button
        if (!document.getElementById('btn-add-ip')) {
            const btn = document.createElement('div');
            btn.id = 'btn-add-ip'; btn.className = 'static-ip-btn static-ip-add'; btn.innerHTML = '➕ 添加绑定';
            fab.appendChild(btn);
            const ui = renderManagementModal('add');
            btn.onclick = () => { ui.modal.style.display = 'flex'; ui.load(); };
        }

        // 3. Delete Button (only on setting pages)
        if (!document.getElementById('btn-del-ip')) {
            const btn = document.createElement('div');
            btn.id = 'btn-del-ip'; btn.className = 'static-ip-btn static-ip-del'; btn.innerHTML = '🗑 删除绑定';
            fab.appendChild(btn);
            const ui = renderManagementModal('del');
            btn.onclick = () => { ui.modal.style.display = 'flex'; ui.load(); };
        }
    }

    setTimeout(initButtons, 1500);
})();
