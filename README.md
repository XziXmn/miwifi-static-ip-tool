# 小米路由器静态IP管理增强脚本

一个为小米/Redmi路由器（AX、BE、RA、RB系列）设计的Tampermonkey用户脚本，让静态IP（MAC绑定）页面更好用。

当前脚本版本：0.6（2025年11月20日）  
适用固件：理论上目前为止任何版本

## 主要功能

- 批量添加/删除静态IP绑定（支持多选 + 手动输入）
-设备自动分类显示（手机、电脑、智能家居、网络设备、虚拟机等7类，带颜色区分）
-内置完整IEEE OUI厂商数据库，支持离线识别
-可选AI厂商深度分类（兼容所有OpenAI格式API，提供中文描述）
-分块并发分析、实时保存、可随时中断
-支持一键导入/导出AI分类结果，首次配置后永久离线可用
-界面优化：浮动按钮、深色模式适配，不干扰原页面

## 安装方式

1. 安装 Tampermonkey 或 Violentmonkey 扩展
2. [点此一键安装](https://greasyfork.org/zh-CN/scripts/XXXXXX)
   或手动新建脚本 → 粘贴代码 → 保存
3. 进入路由器后台即可看到右下角 ⚙️ 和 ➕ 按钮

## 快速上手

1. 点击 ⚙️ → “立即检查并更新OUI原始库”
2. （推荐）直接上传社区最新的AI分类数据库（[下载](https://raw.githubusercontent.com/XziXmn/miwifi-static-ip-tool/refs/heads/main/xiaomi_ai_vendor_db.json)）  
3. 勾选「启用AI厂商分类」→ 保存配置 → 刷新页面
4. 分类和颜色立即生效

## 常用免费/低成本API配置（2025年实测可用）

| 服务商     | API Base URL                                   | 推荐模型                        | 建议并发 |
|------------|------------------------------------------------|---------------------------------|----------|
| 硅基流动   | https://api.siliconflow.cn/v1/chat/completions | deepseek-ai/DeepSeek-V3       | 5–8     |
| Groq       | https://api.groq.com/openai/v1/chat/completions| llama-3.1-70b-versatile       | 3–5     |
| DeepSeek   | https://api.deepseek.com/v1/chat/completions   | deepseek-chat                   | 4–6     |


## 常见问题

- 上传AI数据库后没效果？  
  请务必在设置里勾选「启用AI厂商分类」后再刷新页面。
- 想自己重新分析？  
  填好API信息 → 点击“保存配置并执行AI厂商分块并发分析”即可，支持随时中断。

## 许可证

MIT License – 欢迎自由使用、修改、分享

## 致谢

- kirin的小米路由器增强脚本
- AI数据库由社区使用DeepSeek-V3 + 人工校对维护

如果觉得好用，点个Star就是对维护者最大的鼓励。

感谢使用，祝管理顺心。
