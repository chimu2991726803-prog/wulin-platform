# 武林平台：Cloudflare Workers 全功能部署教程

这份项目已经移除了 Windows 专用的 `node.exe`，并把原来本地 JSON 文件、会话以及图片的存储改为 **SQLite-backed Durable Object**。网页版原有 API 路径不变。

**注意**：必须通过 **Cloudflare Workers + Wrangler** 发布。不能把这整个 ZIP 直接拖进 Cloudflare Pages 的静态文件上传框，否则数据库和 API 无法运行。

## 第一步：准备

1. 在电脑上安装 Node.js 20 或更新版本。Mac M3 请安装 macOS Apple Silicon 版本，**不需要 `node.exe`**。
2. 将本压缩包解压，用 VS Code 打开解压后的文件夹。
3. 打开 VS Code 菜单 **终端 → 新建终端**，输入：

```bash
npm install
npx wrangler login
```

按提示浏览器登录自己的 Cloudflare 账号。

## 第二步：设置首次管理员密钥（公开网站必需）

第一次部署前，设置一个只有你知道的、**和管理员密码不同**的随机密钥：

```bash
npx wrangler secret put ADMIN_SETUP_KEY
```

终端会提示你输入一段密码（输入时不会显示字符），例如可用密码管理器生成 **至少 24 位随机字符串**。**不要把它写进 HTML、聊天记录或 GitHub 仓库。**

> 如果 Wrangler 提示 Worker 尚未创建，先执行 `npx wrangler deploy`，然后再执行上面的设置密钥命令即可。在填写密钥之前，初始化管理员会被拒绝。

## 第三步：部署

```bash
npm run deploy
```

Cloudflare 会创建一个名为 `wulin-platform` 的 Worker，并自动创建名为 `WulinPlatform` 的 SQLite-backed Durable Object 类/绑定。**第一次可能弹出创建对象或收费确认，认真阅读账户当前套餐提示。**

成功后终端会显示类似 `https://wulin-platform.你的子域.workers.dev` 的真实地址（不要把示例当成你的网址）。

- 用户端：`https://你的真实网址/`
- 管理端：`https://你的真实网址/admin`

管理端第一次使用：填写 **管理员用户名、管理员口令、刚才设置的 Cloudflare 初始化密钥**；创建成功后以后只需要用户名及口令。

## 本地预览（可选）

```bash
npm run dev
```

打开 Wrangler 显示的本地网址（通常是 `http://localhost:8787`）。本地测试不读取线上 secret；在项目根目录新建仅自己保留的 `.dev.vars`：

```ini
ADMIN_SETUP_KEY="请替换成自己的本地随机密钥"
```

`.dev.vars` 已被 `.gitignore` 排除，不要上传到 GitHub。**本地和线上数据是两套独立数据，不会自动同步**。

## 升级更新

修改 HTML 或业务代码后，在项目终端重新运行：

```bash
npm run deploy
```

正常更新不应删除 SQLite Durable Object 中原有数据。**切勿随意修改** `src/index.js` 内 `idFromName('wulin-platform-main-v1')`、`wrangler.jsonc` 内 `name`、Durable Object 类名和 exports 配置，否则可能连接到新的空数据库。

## 数据存储、容量、备份

- 用户、管理员、抽奖、奖励、帖子等数据：Durable Object 的 SQLite 表按记录存储。
- 用户登录会话：存储在 SQLite 表，设有 7 天有效期。
- 用户配图：拆成小于 2MB 的分块写入 SQLite，继续沿用原项目的 **最多 3MB/张** 规则。
- 适合小型、单站点武林平台。单一对象会串行处理所有 API，**不是为大量并发用户设计**。Cloudflare Durable Objects 具有免费套餐配额但仍受请求/存储等限制，请查看官方定价；超出套餐限制可能产生费用或被限流。
- SQLite 数据不会存回你电脑 `data/` 文件夹。如果将来需要备份/迁移真实线上账号数据，应单独实现管理员导出或使用 Cloudflare Durable Objects 提供的 PITR 功能。**不要在未备份时删除 Worker/对象命名空间。**

## 重要的安全建议

- 管理后台和所有账号请使用不同且复杂的密码，定期检查账户及访问日志。
- 本项目保留了原网站功能和客户端逻辑，现已增加首次管理员初始化密钥和 PBKDF2 密码哈希。**上线前仍建议完成安全审查、真实多人测试，避免立即用于真实金钱交易、敏感隐私数据。**
- 若此前在别的服务器运行过旧版本，这个上传压缩包里 **没有 `data/` 实际账户数据**，因此无法自动迁移旧账号、奖品和抽奖历史。
- 如果需要把网站部署在 Cloudflare Pages 项目已有的同一个自定义域名，需另外配置 Workers 自定义域或路由；默认会获得新的 `workers.dev` 地址。

## 项目结构

```
public/index.html         用户端
public/admin.html         管理后台（多了首次初始化密钥输入框）
src/index.js             Worker 入口和 Durable Object 路由
src/api.js               已迁移的完整 API/业务逻辑
wrangler.jsonc           Workers + Durable Objects 配置
package.json             npm 命令
legacy/server.local.js   旧 Node.js 服务器，仅备份，不参与部署
```
