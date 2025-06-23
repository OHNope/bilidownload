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
    console.log("⏳ Generating TypeScript declarations...");
    console.time("d.ts generation"); // <--- 开始计时

    exec("tsc --emitDeclarationOnly", (error, _stdout, stderr) => {
      if (error) {
        console.error(`❌ tsc build failed: ${error.message}`);
        // 打印 stderr 帮助调试
        if (stderr) {
          console.error(`stderr: ${stderr}`);
        }
        console.timeEnd("d.ts generation"); // <--- 在失败时也结束计时
        return;
      }
      // tsc 可能会在成功时向 stderr 输出警告，所以只作为警告打印
      if (stderr) {
        console.warn(`tsc stderr (may contain warnings): ${stderr}`);
      }
      console.log("✅ TypeScript declaration files generated.");
      console.timeEnd("d.ts generation"); // <--- 在成功时结束计时并打印时间
    });
  } catch (e) {
    console.error("❌ Build failed:", e);
    process.exit(1);
  }
}

build();
