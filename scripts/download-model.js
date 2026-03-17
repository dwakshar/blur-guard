import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const modelDir = path.join(rootDir, "public", "models", "mobilenet_v2");

const modelBaseUrl =
  "https://raw.githubusercontent.com/infinitered/nsfwjs/master/models/mobilenet_v2";

async function main() {
  await mkdir(modelDir, { recursive: true });
  await downloadModelArtifacts();
  console.log("[BlurGuard] Model artifacts are ready.");
}

async function downloadModelArtifacts() {
  const modelJsonUrl = `${modelBaseUrl}/model.json`;
  const modelJsonPath = path.join(modelDir, "model.json");

  await downloadToFile(modelJsonUrl, modelJsonPath);

  const modelJson = JSON.parse(await readFile(modelJsonPath, "utf8"));
  const weightPaths = new Set();

  for (const manifest of modelJson.weightsManifest ?? []) {
    for (const weightPath of manifest.paths ?? []) {
      weightPaths.add(weightPath);
    }
  }

  await Promise.all(
    [...weightPaths].map((weightPath) =>
      downloadToFile(
        `${modelBaseUrl}/${weightPath}`,
        path.join(modelDir, weightPath)
      )
    )
  );
}

async function downloadToFile(url, destination) {
  await mkdir(path.dirname(destination), { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    if (await exists(destination)) {
      console.warn(
        `[BlurGuard] Using existing file for ${path.basename(destination)} after download failure.`
      );
      return;
    }

    throw new Error(`[BlurGuard] Failed to download ${url}: ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
