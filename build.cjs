// build.js
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

async function build() {
  const headerPath = path.join(__dirname, "src", "header.txt");
  let headerContent = "";

  try {
    headerContent = fs.readFileSync(headerPath, "utf8");
  } catch (error) {
    console.warn(
      `Warning: Could not read header file at ${headerPath}. Skipping header.`,
    );
  }

  // esbuild 配置
  const commonOptions = {
    entryPoints: ["src/main.ts"], // 主入口文件
    bundle: true, // 打包所有文件
    outfile: "dist/bundle.js", // 输出文件
    format: "esm", // 输出模块格式
    platform: "browser", // 简化点：目标平台应为 'browser'
    sourcemap: true, // 生成 sourcemap
    banner: {
      js: headerContent, // 注入用户脚本头部
    },
  };

  try {
    // 1. 构建 JavaScript 文件
    await esbuild.build(commonOptions);
    console.log("✅ JS build complete with header.");

    // 2. 调用 tsc 生成 .d.ts 文件 (在 tsconfig.json 中配置)
    // 这个命令现在是构建流程中唯一生成类型的地方
    exec("tsc --emitDeclarationOnly", (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ tsc build failed: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`❌ tsc stderr: ${stderr}`);
        return;
      }
      console.log("✅ TypeScript declaration files generated.");
    });
  } catch (e) {
    console.error("❌ Build failed:", e);
    process.exit(1);
  }
}

build();
