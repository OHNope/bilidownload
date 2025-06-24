import { TaskSelectScript } from "./task-select/index";
import { BiliSelectScript } from "./bili-select/index";
import { gmFetch, addSingleVideo } from "./core/utils";
import type { CustomWindow } from "./core/types";

// CSS Selectors
const CONTAINER_SELECTOR = "div.video-pod__list.section";
const ITEM_SELECTOR = "div.pod-item.video-pod__item.simple";

/**
 * 检查并提取【第一个】匹配容器元素下的 data-key 属性。
 * Checks for the first container and extracts data-key attributes from its matching descendant items.
 *
 * @param {Document | Element} rootNode - The node to start searching from (e.g., document or a specific element). Defaults to browser's `document`.
 * @returns {string[]} An array of data-key strings, or an empty array if the container or items are not found, or items lack the attribute.
 */
function extractKeysFromFirstContainer(
  rootNode: Document | Element = document,
): string[] {
  console.log(`\n--- 正在查找第一个容器: '${CONTAINER_SELECTOR}' ---`);

  // 1. 查找第一个容器. 使用 <HTMLDivElement> 明确类型，返回值可能是 HTMLDivElement 或 null
  const containerDiv: HTMLDivElement | null =
    rootNode.querySelector<HTMLDivElement>(CONTAINER_SELECTOR);

  // 2. 判断容器是否存在 (TypeScript 严格空检查会要求必须处理 null)
  if (!containerDiv) {
    console.warn(`❌ 未找到容器元素: '${CONTAINER_SELECTOR}'`);
    return [];
  }

  console.log(`✅ 已找到第一个容器元素。`);

  // 3. 从容器内部查找所有匹配的子元素, 返回 NodeListOf<HTMLDivElement>
  const itemDivs: NodeListOf<HTMLDivElement> =
    containerDiv.querySelectorAll<HTMLDivElement>(ITEM_SELECTOR);

  if (itemDivs.length === 0) {
    console.log(`ℹ️  容器内未找到符合条件的子元素: '${ITEM_SELECTOR}'`);
    return [];
  }
  console.log(
    `✅ 在容器内找到 ${itemDivs.length} 个符合选择器 '${ITEM_SELECTOR}' 的子元素。`,
  );

  // 4. 提取 data-key
  const dataKeys = Array.from(itemDivs)
    // getAttribute 返回 string | null
    // dataset.key 返回 string | undefined (dataset 属性只在 HTMLElement 上明确存在)
    .map((item) => item.getAttribute("data-key"))
    // 关键: 使用 Type Guard (类型守卫: key is string)
    // 告诉 TypeScript 过滤后，数组里只剩下 string, 不再包含 null
    .filter((key): key is string => key !== null);

  // 或者使用 flatMap (更简洁):
  /*
       const dataKeys = Array.from(itemDivs).flatMap(item => {
           const key = item.getAttribute('data-key');
            // 如果 key 是 null, 返回 [], flatMap 会自动忽略它；否则返回包含 key 的数组 [key]
           return key === null ? [] : [key];
       });
      */
  console.log(`✅ 成功提取 ${dataKeys.length} 个 data-key。`);
  return dataKeys;
}

(async () => {
  // Type unsafeWindow as CustomWindow directly
  "use strict";
  const LOG_PREFIX_MAIN = "[BiliBiliDownload Main]";
  const FAVLIST_URL_PATTERN =
    /space\.bilibili\.com\/([0-9]+)\/favlist\?fid=([0-9]+)/;
  const VIDEO_PATTERN =
    /^https:\/\/www\.bilibili\.com\/video\/BV([a-zA-Z0-9]+)\/?.*?$/;

  const url = unsafeWindow.location.href;
  const MatchFavlist = url.match(FAVLIST_URL_PATTERN);
  const MatchVideo = url.match(VIDEO_PATTERN);

  console.log(`${LOG_PREFIX_MAIN} URL: ${url}`);
  console.log(`${LOG_PREFIX_MAIN} Favlist Match:`, MatchFavlist);
  console.log(`${LOG_PREFIX_MAIN} Video Match:`, MatchVideo);

  // Initialize the Task Selector UI first, so other scripts can interact with it.
  TaskSelectScript();

  if (MatchFavlist && MatchFavlist[1] && MatchFavlist[2]) {
    unsafeWindow.folders = new Map<string, string>();
    const upMid = MatchFavlist[1];
    const fid = MatchFavlist[2];
    console.log(`${LOG_PREFIX_MAIN} Fetching folders for up_mid: ${upMid}`);

    try {
      const json = await gmFetch<any>({
        method: "GET",
        url: `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${upMid}`,
        responseType: "json", // Let GM handle JSON parsing
        headers: {
          Referer: `https://space.bilibili.com/${upMid}/favlist`,
        },
      });

      if (json && json.data && json.data.list) {
        json.data.list.forEach((folder: any) => {
          unsafeWindow.folders!.set(String(folder.id), String(folder.title));
        });
        console.log(`${LOG_PREFIX_MAIN} Folders loaded:`, unsafeWindow.folders);
      } else {
        console.error(
          `${LOG_PREFIX_MAIN} Unexpected folder API response format:`,
          json,
        );
      }
    } catch (error) {
      console.error(`${LOG_PREFIX_MAIN} Failed to fetch folders:`, error);
    }

    // Initialize the BiliSelect script after getting the folders
    BiliSelectScript(fid);
  } else if (MatchVideo && MatchVideo[1]) {
    let bvId = MatchVideo[1]; // The BV ID from the URL path
    if (!bvId) {
      const bvQueryMatch = url.match(/(?<=bvid=)[a-zA-Z0-9]+/);
      if (bvQueryMatch && bvQueryMatch[0]) {
        bvId = bvQueryMatch[0];
      }
    }

    if (bvId) {
      console.log(`${LOG_PREFIX_MAIN} Video page detected, BV: ${bvId}`);
      // Add the video to a default tab in the Task Selector
      extractKeysFromFirstContainer(unsafeWindow.document).forEach((ele) => {
        addSingleVideo("default", "视频页", ele);
      });
      addSingleVideo("default", "视频页", bvId);
    } else {
      console.log(
        `${LOG_PREFIX_MAIN} Video page detected, but could not extract BV ID.`,
      );
    }
  } else {
    console.log(
      `${LOG_PREFIX_MAIN} Not on a matching favlist or video page. Script is idle.`,
    );
  }
})();
