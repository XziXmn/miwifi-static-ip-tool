# 🚀 小米路由器静态 IP 管理增强脚本

[![Script Version](https://img.shields.io/badge/Version-0.6-blue?style=flat-square)](https://greasyfork.org/zh-CN/scripts/XXXXXX)
[![Router](https://img.shields.io/badge/Support-Xiaomi%20%2F%20Redmi%20Router-orange?style=flat-square)]()
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)]()

一个专为小米/Redmi 路由器（AX、BE、RA、RB 系列）官方固件设计的 Tampermonkey 用户脚本。它彻底重构了简陋的静态 IP（DHCP 绑定）管理页面，引入了批量操作、自动设备分类和 AI 辅助识别功能。

> **当前版本**：0.6（2025年11月20日）
> **适用环境**：理论上支持目前为止所有官方固件版本。

## ✨ 核心功能

### 1. 强大的设备管理
- **批量操作**：支持多选复选框，一键批量解除绑定。
- **手动批量添加**：支持通过文本格式批量导入静态 IP 绑定（格式：`MAC IP 备注`）。
- **界面优化**：浮动按钮、深色模式适配，不干扰原页面，提供更佳的用户体验。

### 2. 智能设备分类与识别
脚本内置了完整的 IEEE OUI 厂商数据库，并结合 AI 算法将设备自动归类为 7 大类，通过颜色标签区分，管理一目了然：
- <span style="color:#10b981">■</span> **手机/平板** (Mobile)
- <span style="color:#0ea5e9">■</span> **个人电脑** (PC)
- <span style="color:#f97316">■</span> **智能家居** (IoT)
- <span style="color:#f59e0b">■</span> **网络设备** (Network - 路由器/AP/NAS)
- <span style="color:#8b5cf6">■</span> **虚拟机** (VM)
- <span style="color:#06b6d4">■</span> **服务器/仓库** (Repo)
- <span style="color:#9ca3af">■</span> **其他设备** (Other)

### 3. AI 深度赋能 (可选)
- **深度识别**：调用 OpenAI 格式兼容的 API（如 DeepSeek, Groq），根据厂商名称生成中文设备描述。
- **离线优先**：支持一键导入社区维护的 `xiaomi_ai_vendor_db.json`，**一次配置，永久离线生效**。
- **并发分析**：支持分块并发处理 OUI 数据库，具备实时保存、进度条显示和随时中断功能。

---

## 📸 效果预览

### 列表界面：自动分类与 AI 备注
自动识别设备类型，并显示由 AI 生成的厂商中文描述。
![列表界面](./微信截图_20251120142221.jpg)

### 设置面板：数据库管理与 AI 配置
支持 OUI 原始库更新、AI 数据库导入/导出及并发分析设置。
![设置面板](./微信截图_20251120142247.jpg)

---

## 📥 安装方式

1. 安装浏览器扩展：[Tampermonkey](https://www.tampermonkey.net/) (推荐) 或 Violentmonkey。
2. **[点击此处一键安装脚本](https://greasyfork.org/zh-CN/scripts/XXXXXX)**
   - 或者：手动新建脚本 -> 粘贴代码 -> 保存。
3. 登录小米路由器后台（静态 IP 管理页面），右下角会出现悬浮按钮组（⚙️ 和 ➕）。

---

## ⚡️ 快速上手（推荐路径）

推荐使用社区维护的数据库，无需自己配置 API key，即可体验完整的分类功能。

1. 进入路由器后台，点击右下角 **⚙️ 设置按钮**。
2. 点击 **“立即检查并更新 OUI 原始库”**。
3. **下载社区 AI 数据库**：[点击下载最新 xiaomi_ai_vendor_db.json](https://raw.githubusercontent.com/XziXmn/miwifi-static-ip-tool/refs/heads/main/xiaomi_ai_vendor_db.json)
4. 在设置面板底部，点击 **“选择文件”** 上传刚才下载的 JSON，点击 **“上传并应用”**。
5. 勾选顶部的 **「启用 AI 厂商分类」** -> 点击 **“仅保存配置”**。
6. 刷新页面，分类和颜色立即生效。

---

## 🛠️ 进阶功能：自定义 AI 分析

如果你希望自己执行 AI 分析，可以参考以下配置。

### 1. 常用免费/低成本 API 配置（2025年实测可用）

| 服务商 | API Base URL (填写到设置中) | 推荐 Model ID | 建议并发数 |
| :--- | :--- | :--- | :--- |
| **硅基流动** | `https://api.siliconflow.cn/v1/chat/completions` | `deepseek-ai/DeepSeek-V3` | 5 – 8 |
| **Groq** | `https://api.groq.com/openai/v1/chat/completions` | `llama-3.1-70b-versatile` | 3 – 5 |
| **DeepSeek** | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` | 4 – 6 |

### 2. 执行分析
1. 在脚本设置面板填入 `API Key`、`Base URL` 和 `Model ID`。
2. 调整并发线程数。
3. 点击 **“保存配置并执行 AI 厂商分块并发分析”**。
4. 完成后，建议点击 **“下载 AI 分类数据库”** 备份你的专属库。

---

## 📝 手动添加设备格式

点击右下角 “➕ 添加绑定” 后，除了填写表单，你还可以在下方文本框中批量粘贴数据。
**格式说明**：`MAC地址` + `空格` + `IP地址` + `空格` + `备注名称` (每行一条)

**示例：**
```text

00:1A:2B:3C:4D:5E 192.168.31.200 游戏PC
A0:B1:C2:D3:E4:F5 192.168.31.150 客厅摄像头

```

---

## ❓ 常见问题

- **上传了 AI 数据库后没效果？**
  请务必在设置里勾选 「启用 AI 厂商分类」 并点击保存配置后再刷新页面。

- **想自己重新分析？**
  填好 API 信息 → 点击 “保存配置并执行 AI 厂商分块并发分析” 即可，支持随时中断。

- **脚本安全吗？**
  脚本代码完全开源。所有数据（配置和数据库）均存储在本地浏览器，不会上传到任何第三方服务器。AI 分析仅将厂商名发送给你配置的 API 服务商。

---

## 📜 许可证与致谢

MIT License – 欢迎自由使用、修改、分享。

- **致谢**: kirin 的小米路由器增强脚本
- **数据维护**: AI 数据库由社区使用 DeepSeek-V3 + 人工校对维护

如果觉得好用，点个 Star 🌟 就是对维护者最大的鼓励。

感谢使用，祝管理顺心。
