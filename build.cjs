// build.js
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

async function build() {
  const headerPath = path.join(__dirname, "src", "header.txt");
  let headerContent = "";

  try {
    headerContent = fs.readFileSync(headerPath, "utf8");
    // esbuild 的 banner 选项会在内容前面自动添加换行符，所以这里不需要特别处理
    // 但是，如果你希望在注释和代码之间有额外的空行，可以在 header.txt 尾部添加
  } catch (error) {
    console.warn(
      `Warning: Could not read header file at ${headerPath}. Skipping header.`,
    );
  }

  // esbuild 配置
  const commonOptions = {
    entryPoints: ["src/main.ts"], // 你的主入口文件，esbuild 会从这里开始打包所有依赖
    bundle: true, // 核心：将所有文件打包成一个
    outfile: "dist/bundle.js", // 打包后的 JS 文件名和路径
    format: "esm", // 输出模块格式 (esnext, cjs 等)
    platform: "node", // 目标平台 (node, browser)
    sourcemap: true, // 生成 sourcemap
    banner: {
      js: headerContent, // 将读取到的 header 内容作为 JS 文件的 banner
    },
  };

  try {
    // 构建 JavaScript 文件
    await esbuild.build(commonOptions);
    console.log("JS build complete with header.");

    // 假设你还需要生成类型声明文件
    // 这里调用 tsc 来生成 .d.ts 文件
    // 注意：tsc 的配置应在 tsconfig.json 中
    const { exec } = require("child_process");
    exec("tsc --emitDeclarationOnly", (error, stdout, stderr) => {
      if (error) {
        console.error(`tsc build failed: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`tsc stderr: ${stderr}`);
        return;
      }
      console.log("TypeScript declaration files generated.");

      // 如果你需要将多个 .d.ts 文件合并成一个
      // 可以使用 dts-bundle-generator 或类似工具
      // 例如：exec('dts-bundle-generator --config dts-bundle-config.json')
    });
  } catch (e) {
    console.error("Build failed:", e);
    process.exit(1);
  }
}

build();
