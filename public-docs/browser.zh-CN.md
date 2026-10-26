---
title: 浏览器自动化
description: 在 Paseo 中给 Agent 一个真实的浏览器，用来打开页面、点击、输入并验证它们的工作。
nav: 概览
---

# 浏览器自动化 {#browser-automation}

Paseo 中的 Agent 可以操作真实的浏览器标签页，也就是你在 Paseo 桌面应用中看到的那些标签页。Agent 可以打开你的开发服务器、读取页面、点击走完一个流程、填写表单并截图，全程不离开你的机器。

这让前端工作形成了闭环：Agent 不再告诉你“这个改动应该能用”，而是打开页面亲自检查。

典型用途：

- **验证自己的改动。** 修改组件后，Agent 打开开发服务器，对页面做快照，确认新的文字或布局确实出现了。
- **复现和诊断 bug。** 按 bug 报告中的确切步骤点击，然后读取控制台和网络日志。
- **完整走查流程。** 表单、多步向导、悬停菜单、拖放、文件上传。
- **在已登录的会话中工作。** 标签页会保留会话状态。你自己登录一次，Agent 就可以在登录后的页面中工作。
- **分离身份。** 当不同标签页需要各自独立的 cookie、登录状态、缓存和站点存储时，创建命名的浏览器配置文件。`browser_new_tab` 接受配置文件名称或 ID，并返回 `profileId` 和 `profileName`。

因为你和 Agent 共享浏览器，你可以看着它工作，并随时介入。

## 启用 {#enabling}

浏览器工具默认关闭。按主机开启：

- **在应用中**：打开 **设置 → 你的主机 → Agents**，开启 **Browser tools**。
- **在 `config.json` 中**（`~/.paseo/config.json`）：

```json
{
  "daemon": {
    "browserTools": {
      "enabled": true
    }
  }
}
```

这些工具属于 [Paseo MCP 工具集](/docs/mcp)，因此同一页面上的 **启用 Paseo tools** 也必须开启，Agent 才能获得它们。已有的 Agent 可能需要重新加载才能获得新工具。

> 浏览器工具允许 Agent 访问和控制 Paseo 浏览器标签页，包括已登录的浏览器状态。只为你信任的 Agent 启用。

## 目前仅限桌面端 {#desktop-only-for-now}

浏览器标签页由 Paseo 桌面应用承载。daemon 本身不运行浏览器：它把工具调用路由到已连接的桌面应用，没有已连接的桌面应用时返回错误。通信协议与宿主无关，因此以后其他宿主也可以承载同样的工具。

## Agent 如何看到页面 {#how-an-agent-sees-a-page}

主要工具是 `browser_snapshot`，它以无障碍树的形式返回页面（标题、文本、表单状态和层级结构），而不是原始 HTML：

```yaml
- document "Settings"
  - heading "Workspace" [level=1]
  - text: "Connected as Maya"
  - textbox "Display name" [ref=@e2]
  - button "Save changes" [ref=@e3]
```

可交互元素带有类似 `@e3` 的引用。Agent 把引用传给 `browser_click`、`browser_fill` 和其他操作工具。引用来自该标签页的最新快照，页面变化后会失效；使用过期的引用会返回错误，而不是作用到错误的元素上。

对于无障碍树无法捕获的内容，Agent 会退回到 `browser_screenshot`，`browser_logs` 则提供控制台消息和网络耗时。

## 导入站点状态 {#importing-site-state}

在 macOS 上，打开工具栏的 **Browser data** 菜单并选择 **Import browser data...**，可以从本机安装的 Chrome、Chromium、Brave、Edge 和 Arc 配置文件中导入允许列表内的 cookie、localStorage 和 sessionStorage。来源、域名和数据类别都由你选择。Paseo 会把数据合并到现有的 Default 浏览器会话中。历史记录、书签、密码、自动填充、下载、缓存、标签页和扩展永远不会被读取。

cookie 数据库和 Chromium 存储数据库会先复制再读取。不支持的记录会被跳过。当 Paseo 需要浏览器的 Safe Storage 密钥来解密 cookie 时，macOS 可能会弹出钥匙串提示。sessionStorage 属于单个标签页，因此这些记录会先报告为已排队，然后只应用一次：应用到 Default 浏览器会话中下一个初始 HTTP(S) URL 同源的新标签页。如果 Paseo 先退出，已排队的记录会丢失。

Agent 工具 `browser_list_import_sources` 和 `browser_import_browser_data`，以及 `paseo browser import-sources` 和 `paseo browser import`，都走同一路径。读取浏览器数据前，Paseo 桌面端会显示原生确认框，其中列出完整的域名允许列表。显示的列表超过 1,000 个字符时，导入会直接失败。导入响应只包含已导入、已排队和已跳过的数量以及警告，从不包含 cookie 或存储的值。取消会停止剩余的工作，但不会回滚已经应用的 cookie 或存储记录。

## 架构 {#architecture}

```
agent ──MCP──▶ daemon (broker) ──▶ browser host (desktop app) ──▶ webview
```

- **按工作区隔离的标签页。** Agent 只能看到和控制自己工作区中的标签页。新标签页在后台打开，不会抢走你的焦点。
- **标签页到宿主的路由。** daemon 记住每个标签页属于哪个宿主，并把标签页命令路由过去。`browser_list_tabs` 汇总所有已连接的宿主。
- **由桌面端管理的配置文件。** Default 保留原有的 Paseo 浏览器数据。命名配置文件使用相互隔离的持久化 Electron 会话。Default 不能删除；每次删除配置文件都需要在桌面端的原生对话框中确认，即使请求来自 MCP 或 CLI。
- **可信输入。** 点击、按键、悬停和拖动都以真实的浏览器输入事件派发：CSS `:hover` 会触发，页面无法区分 Agent 的点击和用户的点击。每个操作都会先等待目标可见、可用且稳定。
- **对话框永不阻塞。** `alert` 会被接受；`confirm`、`prompt` 和 `beforeunload` 会被取消。每个被处理的对话框都会在工具结果中报告，让 Agent 知道页面流程发生了变化。

## 安全 {#security}

- 导航仅限 `http(s)` URL。
- 文件上传只能引用 Agent 工作区内的文件。
- 标签页使用所选的 Paseo 浏览器配置文件，包括其中的 cookie 和登录状态。命名配置文件的浏览器数据与 Default 以及彼此之间相互隔离。

完整的工具列表见[工具参考](/docs/browser-tools)。
