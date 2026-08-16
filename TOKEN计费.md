# 2026年8月17日调价前TOKEN消费记录

注意：以下是deepseek的消费信息，其中绝大部分是deepseek-v4-flash的调用，之所以记录，是因为2026年8月17日开始deepseek token涨价，幅度较大，所以留作对比

## 2026年6月1日到6月30日（30天）
消费金额
¥739.02
API 请求次数
91,885
Tokens
15,878,792,271

## 2026年7月1日到7月31日（31天）
消费金额
¥175.51
API 请求次数
24,534
Tokens
3,069,305,707



# 模型 & 价格

下表所列模型价格以“百万 tokens”为单位。Token 是模型用来表示自然语言文本的最小单位，可以是一个词、一个数字或一个标点符号等。我们将根据模型输入和输出的总 token 数进行计量计费。

## 峰谷定价说明

自北京时间 2026年8月17日 00:00 起，DeepSeek API 采用峰谷定价机制：

-   **高峰时段**：北京时间 9:00–12:00、14:00–18:00
-   **空闲时段**：其余时间
-   **空闲时段价格 = 高峰时段价格的一半**

## 模型细节与价格（CNY / 百万 tokens）

| | deepseek-v4-flash (1) | deepseek-v4-pro |
| :--- | :--- | :--- |
| **BASE URL (OpenAI 格式)** | [https://api.deepseek.com](https://api.deepseek.com) | [https://api.deepseek.com](https://api.deepseek.com) |
| **BASE URL (Anthropic 格式)** | [https://api.deepseek.com/anthropic](https://api.deepseek.com/anthropic) | [https://api.deepseek.com/anthropic](https://api.deepseek.com/anthropic) |
| **模型版本** | DeepSeek-V4-Flash | DeepSeek-V4-Pro (0813 正式版) |
| **思考模式** | 支持非思考与思考模式（默认）切换方式详见 [思考模式](/zh-cn/guides/thinking_mode) | 支持非思考与思考模式（默认），支持 low/high/max 三档切换方式详见 [思考模式](/zh-cn/guides/thinking_mode) |
| **上下文长度** | 1M | 1M |
| **输出长度** | 最大 384K | 最大 384K |
| **功能: Json Output** | 支持 | 支持 |
| **功能: Tool Calls** | 支持 | 支持（Agent 能力增强） |
| **功能: Responses API** | 支持 | 原生支持 |
| **功能: 对话前缀续写（Beta）** | 支持 | 支持 |
| **功能: FIM 补全（Beta）** | 仅非思考模式支持 | 仅非思考模式支持 |
| **价格: 输入（缓存命中）- 空闲时段** | 0.05 元 | 0.15 元 |
| **价格: 输入（缓存命中）- 高峰时段** | 0.10 元 | 0.30 元 |
| **价格: 输入（缓存未命中）- 空闲时段** | 1.5 元 | 4.5 元 |
| **价格: 输入（缓存未命中）- 高峰时段** | 3 元 | 9 元 |
| **价格: 输出 - 空闲时段** | 4.5 元 | 13.5 元 |
| **价格: 输出 - 高峰时段** | 9 元 | 27 元 |
| **并发限制 (2)** | 2500 | 500 |

> (1) `deepseek-chat` 与 `deepseek-reasoner` 两个模型名将于北京时间 2026/07/24 23:59 弃用。出于兼容考虑，二者分别对应 `deepseek-v4-flash` 的非思考与思考模式。
>
> (2) 更多并发限制细节，请参考[限速与隔离](/zh-cn/quick_start/rate_limit)

## 扣费规则

-   扣减费用 = token 消耗量 × 模型单价（根据调用时段适用高峰或空闲价格），对应的费用将直接从充值余额或赠送余额中进行扣减。
-   当充值余额与赠送余额同时存在时，优先扣减赠送余额。
-   产品价格可能发生变动，DeepSeek 保留修改价格的权利。请您依据实际用量按需充值，定期查看此页面以获知最新价格信息。