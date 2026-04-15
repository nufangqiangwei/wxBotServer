# botServer 接口与运行说明

本文档用于承接 `README` 之外的详细说明。

## 服务信息

- 默认地址：`http://127.0.0.1:8787`
- 健康检查：`GET /healthz`
- 兼容路径：`/api/...` 与 `/api/v1/...`
- 推荐路径：`/api/v2/...`

`v2` 使用凭证式语义，由服务内部维护账号绑定、微信游标、会话历史和最近 `context_token`，上层调用方不再需要自行传 `accountId`、`userId`、`contextToken`。

## 状态目录

建议生产环境显式设置 `WEIXIN_HTTP_STATE_DIR`。

目录内会保存：

- `accounts/<accountId>.json`：登录后的 bot token 和账号信息
- `accounts/<accountId>.state.json`：拉消息游标及最近会话上下文
- `tmp/`：远程媒体下载的临时文件

## v2 接口摘要

### 账号与登录

- `GET /api/v2/accounts`：查看凭证列表
- `GET /api/v2/state?credential=<credential>`：查看凭证状态
- `POST /api/v2/auth/qr/start`：创建扫码登录会话
- `POST /api/v2/auth/qr/wait`：等待扫码结果

登录会话要求调用方提供唯一 `credential`。创建后若 3 分钟内未进入等待阶段，会话会自动清理并释放该凭证。

### 收发消息

- `POST /api/v2/updates/get`：按凭证拉取自上次调用以来的消息增量
- `GET /api/v2/messages/history?credential=<credential>`：查看全部历史消息
- `POST /api/v2/messages/text`：按 `conversationId` 发送文本
- `POST /api/v2/messages/media`：按 `conversationId` 发送媒体

`updates/get` 和 `messages/history` 返回的消息记录里会带 `conversationId`，后续发消息直接使用该字段。

### 输入状态

- `POST /api/v2/config/get`：获取 typing ticket
- `POST /api/v2/typing/send`：发送输入中状态

## 旧接口说明

- `/api/...` 与 `/api/v1/...` 仍保留兼容
- 旧登录入口 `POST /api/auth/qr/start` 与 `POST /api/v1/auth/qr/start` 已废弃并关闭
- 新接入方应统一改用 `POST /api/v2/auth/qr/start`

## 调用建议

- 新项目只接 `v2`
- 调用方内部只保存 `credential` 和业务侧需要的会话映射，不再依赖旧版三元组参数
- 若需要部署示例或 systemd 配置，参考 [`../../deploy/systemd/README.md`](../../deploy/systemd/README.md)
