# botServer

独立的微信 HTTP 服务，只负责和微信服务器交互，对外提供登录、收消息、发消息等能力。

## 适用场景

- 作为微信通道基础服务单独运行
- 为 `weixinRemid` 或其他上层系统提供 `v2` 接口
- 在本地目录持久化账号、会话游标和消息上下文

## 运行要求

- Node.js 22+

## 快速启动

```bash
cd botServer
npm install
npm start
```

默认监听 `0.0.0.0:8787`。

## 配置摘要

常用环境变量：

- `WEIXIN_HTTP_HOST`
- `WEIXIN_HTTP_PORT`
- `WEIXIN_HTTP_STATE_DIR`
- `WEIXIN_API_BASE_URL`
- `WEIXIN_CDN_BASE_URL`
- `WEIXIN_APP_ID`
- `WEIXIN_CHANNEL_VERSION`
- `LOG_LEVEL`

状态目录默认优先使用仓库根目录 `.weixin-http-state`，不存在时退回 `botServer/.weixin-http-state`。

## 文档入口

- 接口与状态目录说明：[`docs/api-reference.md`](./docs/api-reference.md)
- systemd 部署示例：[`../deploy/systemd/README.md`](../deploy/systemd/README.md)

`README` 只保留项目概览；详细接口、登录流程和调用示例请放在引用文档中查看。
