# Auto Register 2925

当前版本已经接入：

- Step 1：通过 VPS 页面自动获取 OAuth
- Step 2 / 3 / 4 / 5：复用 `multiPagePlugins` 的 OpenAI 注册流程
- 2925 邮箱轮询地址：`https://www.2925.com/#/mailList`
- 2925 无限别名：`主邮箱 local_part + _suffix @2925.com`

## 说明

- 如果填写了 `VPS`，默认按 1 -> 5 全流程执行
- 如果没填 `VPS` 但填了 `OAuth`，会跳过 Step 1，直接从 Step 2 开始
- 2925 邮箱当前优先直接从页面 DOM 表格读取邮件列表，并在轮询时主动点击“刷新”
- 邮箱验证码轮询策略统一为：3 秒一次、每轮 10 次、总共 5 轮（含首次），轮询失败后会点击重试/重发
- `Password` 留空时会自动生成 OpenAI 账号密码
- `Email` 字段为运行时生成结果，只读展示
