// build.js
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

// 1. 读取 UserScript 头信息
const userscriptHeader = fs.readFileSync(
  path.join(__dirname, "src", "header.txt"),
  "utf8",
);

// 2. esbuild 的构建配置
const buildOptions = {
  entryPoints: [path.join(__dirname, "src", "main.ts")], // 入口文件
  bundle: true, // 关键：告诉 esbuild 将所有依赖打包成一个文件
  outfile: path.join(__dirname, "dist", "bundle.user.js"), // 输出文件
  banner: {
    // 在文件顶部添加内容
    js: userscriptHeader, // 将我们的头信息作为 JS banner 添加
  },
  platform: "browser", // 目标平台是浏览器
  charset: "utf8", // 文件编码
  // sourcemap: true,         // (可选) 生成 sourcemap 文件，方便调试
};

// 3. 检查是否有 --watch 参数
const shouldWatch = process.argv.includes("--watch");

if (shouldWatch) {
  // 使用 context API 进入观察模式
  esbuild
    .context(buildOptions)
    .then((ctx) => {
      console.log("👀 Watching for changes...");
      ctx.watch();
    })
    .catch((err) => {
      console.error("Watch mode failed:", err);
      process.exit(1);
    });
} else {
  // 执行单次构建
  esbuild
    .build(buildOptions)
    .then(() => {
      console.log("✅ Build complete!");
    })
    .catch((err) => {
      console.error("Build failed:", err);
      process.exit(1);
    });
}
