// build.cjs
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

  // esbuild 配置 (保持不变)
  const commonOptions = {
    entryPoints: ["src/main.ts"],
    bundle: true,
    outfile: "dist/bundle.js",
    format: "esm",
    platform: "browser",
    sourcemap: true,
    banner: {
      js: headerContent,
    },
  };

  try {
    // 1. 构建 JavaScript 文件 (保持不变)
    console.log("⏳ Starting JS build with esbuild...");
    console.time("JS build time");
    await esbuild.build(commonOptions);
    console.log("✅ JS build complete with header.");
    console.timeEnd("JS build time");

    // 2. 调用 tsc --build 生成 .d.ts 文件
    console.log(
      "⏳ Generating TypeScript declarations using project references...",
    );
    console.time("d.ts generation");

    // --- MODIFICATION START ---
    // 使用 tsc --build (或 tsc -b) 来编译整个项目引用图
    // 它会读取根 `tsconfig.json` 并智能地构建所有部分
    exec("tsc --build", (error, _stdout, stderr) => {
      // --- MODIFICATION END ---
      if (error) {
        console.error(`❌ tsc build failed: ${error.message}`);
        if (stderr) {
          console.error(`stderr: ${stderr}`);
        }
        console.timeEnd("d.ts generation");
        return;
      }
      if (stderr) {
        // tsc --build 经常会在 stderr 中输出状态信息，不一定是错误
        console.log(`tsc output: ${stderr}`);
      }
      console.log("✅ TypeScript declaration files generated.");
      console.timeEnd("d.ts generation");
    });
  } catch (e) {
    console.error("❌ Build failed:", e);
    process.exit(1);
  }
}

build();
