# BiliBiliDownload (TS)

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](./LICENSE-MIT)
[![TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-blue.svg)](https://www.typescriptlang.org/)

这是一个强大的油猴脚本，旨在增强Bilibili网站的视频下载体验。它提供了先进的视频选择和批量下载管理功能，特别适用于从收藏夹中批量处理视频。

## ✨ 特性

-   **高级视频选择**:
    -   在收藏夹页面，通过单击、拖拽框选等方式轻松选择多个视频。
    -   选择状态高亮显示，直观明了。
    -   跨分页数据持久化，切换页面不会丢失已选项。
-   **浮动任务管理器**:
    -   所有选中的视频（分P）会汇集到一个可拖动、可缩放、可折叠的浮动窗口中。
    -   按来源收藏夹自动分标签页（Tab）管理。
    -   提供“全选”、“全不选”、“选择可见项”等快捷操作。
-   **可靠的批量下载**:
    -   支持并发下载，可配置同时下载的任务数量。
    -   断点续传：利用IndexedDB保存下载进度，关闭或刷新页面后可继续下载。
    -   自动重试：下载失败的任务会自动尝试重新下载。
    -   下载完成后，所有视频文件将被打包成一个`.zip`文件，方便保存。
-   **模块化与可扩展API**:
    -   脚本核心功能通过 `window.TaskSelectorManager` API 暴露，允许其他脚本与其交互。
    -   清晰的模块化结构 (`core`, `bili-select`, `task-select`)，易于维护和扩展。
    -   使用 TypeScript 编写，提供类型安全和更好的开发体验。

## 🚀 安装与构建

### 安装 (用户)

要使用此脚本，您需要一个用户脚本管理器，例如：

-   [Tampermonkey](https://www.tampermonkey.net/) (推荐)
-   [Violentmonkey](https://violentmonkey.github.io/)

安装管理器后，将 `dist/bundle.js` 的内容复制到管理器的新建脚本中即可。

### 构建 (开发者)

如果您想从源代码构建此项目，请按照以下步骤操作：

1.  **克隆仓库**
    ```bash
    git clone https://github.com/OHNope/bilidownload
    cd bilidownload
    ```

2.  **安装依赖**
    ```bash
    npm install
    ```

3.  **构建脚本**
    ```bash
    npm run build
    ```
    此命令会执行以下操作：
    -   使用 `tsc --build` 编译TypeScript代码，并生成类型定义文件 (`.d.ts`)。
    -   使用 `esbuild` 将所有代码（包括 `header.txt` 用户脚本元数据）打包成一个单独的JS文件：`dist/bundle.js`。

## 📖 使用方法

### 1. 视频选择 (在收藏夹页面)

-   **单击选择/取消**: 在视频封面上单击（避开标题链接）即可选中或取消选中该视频。
-   **拖拽框选**: 在视频列表的空白区域按下鼠标左键并拖动，可以创建一个选框，批量选择/取消选择框内的视频。
-   **跨页选择**: 你的选择会自动保存在浏览器中。即使你切换到收藏夹的下一页或刷新页面，之前的选择仍然会被保留和高亮。

### 2. 任务管理器 (浮动窗口)

所有被选中的视频及其分P会自动出现在屏幕左上角的 **"任务选择器"** 窗口中。

-   **拖动与缩放**: 按住窗口头部可以拖动，拖动右下角可以调整窗口大小。
-   **折叠/展开**: 点击标题右侧的 `+` / `-` 按钮可以折叠或展开窗口。
-   **分P列表**: 窗口内按收藏夹自动创建标签页，展示所有视频的分P列表。
-   **快捷按钮**:
    -   `确认选中`: 将当前所有 **浅蓝色高亮** 的任务加入下载队列，并打开一个新的下载进度窗口。
    -   `选可见`: 仅选择当前列表中可见的分P。
    -   `全不选`: 取消所有标签页中所有分P的选择。
    -   `去可见`: 取消选择当前列表中可见的分P。
    -   `选分页`: 选择当前标签页下的所有分P。
-   **分P操作**: 单击分P项可以独立选择或取消选择。

### 3. 下载流程

1.  在 **"任务选择器"** 窗口中，使用上述方法选择好你想要下载的分P。
2.  点击 `确认选中` 按钮。
3.  一个新的 **"任务进度"** 窗口会出现，开始下载。
4.  你可以同时创建多个下载批次（即多个进度窗口）。
5.  下载完成后，进度窗口右上角的关闭按钮 `✕` 会亮起，此时可以安全关闭。
6.  所有文件下载完成后，会自动弹出一个新页面，提供一个`.zip`压缩包的下载链接。

## ⚙️ 核心API: `TaskSelectorManager`

本脚本通过 `unsafeWindow.TaskSelectorManager` 暴露了一套功能丰富的API，允许其他脚本或开发者进行编程交互。

### 获取API实例

```javascript
// 检查API是否存在
if (unsafeWindow.TaskSelectorManager) {
  const manager = unsafeWindow.TaskSelectorManager;
  // ... 使用 manager 对象
}
```

### 主要方法详解

#### `addTaskData(tabId, tabName, parentTaskInputs, autoSelectNewChildren?)`

向任务选择器中添加新的视频数据。这是最核心的添加方法。

-   `tabId` (string): 标签页的唯一ID。推荐使用收藏夹的`fid`。
-   `tabName` (string): 标签页显示的名称，例如收藏夹的标题。
-   `parentTaskInputs` (Array<Object>): 一个包含父视频信息的数组。每个对象结构如下：
    ```typescript
    {
      videoTitle: string; // 视频主标题
      bvId: string;       // 视频的BV号
      pages: {            // 视频的分P列表
        cid: string;      // 分P的CID
        part: string;     // 分P的标题
      }[];
    }
    ```
-   `autoSelectNewChildren` (boolean, 可选): 如果为`true`，新添加的所有分P将自动被设为选中状态。默认为`false`。

**示例：**

```javascript
const videoInfo = [{
  videoTitle: "【编程】TypeScript入门到精通",
  bvId: "BV1fb411A7cv",
  pages: [
    { cid: "123456", part: "P1. 环境搭建" },
    { cid: "123457", part: "P2. 基本类型" }
  ]
}];

// 将视频添加到ID为'98765'，名称为'学习资料'的标签页下
manager.addTaskData("98765", "学习资料", videoInfo, true);
```

#### `selectTasksByBv(bvId, shouldSelect)`

根据BV号，批量选中或取消选中其下的所有分P。

-   `bvId` (string): 目标视频的BV号。
-   `shouldSelect` (boolean): `true`为选中，`false`为取消选中。

**示例：**

```javascript
// 选中 "BV1fb411A7cv" 的所有分P
manager.selectTasksByBv("BV1fb411A7cv", true);
```

#### `isAnyTaskSelectedForBv(bvId)`

检查一个BV号下是否有任何一个分P被选中。

-   `bvId` (string): 目标视频的BV号。
-   **返回**: `boolean`

**示例：**

```javascript
if (manager.isAnyTaskSelectedForBv("BV1fb411A7cv")) {
  console.log("这个视频至少有一个分P被选中了。");
}
```

#### `isTaskSelected(taskId)`

检查单个分P是否被选中。

-   `taskId` (string): 目标分P的CID。
-   **返回**: `boolean`

#### `getSelectedTaskIds()`

获取当前所有已选中的分P的CID列表。

-   **返回**: `string[]`

#### `destroy()`

销毁任务选择器实例，移除所有UI元素和事件监听器，并重置所有状态。这在需要重新加载或替换脚本逻辑时非常有用。

## 🤝 贡献

欢迎任何形式的贡献，包括但不限于：

-   报告Bug
-   提交功能建议
-   发送Pull Request

## 📜 许可证

本项目采用双重许可，您可以在以下两种协议中任选其一：

-   **Apache License, Version 2.0** (详情见 `LICENSE-APACHE` 文件)
-   **MIT License** (详情见 `LICENSE-MIT` 文件)

您可以根据自己的需要选择任意一种许可证来使用、分发和修改本软件。
