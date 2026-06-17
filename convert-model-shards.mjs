// Converts binary model weight shards to base64-encoded JSON so Opera's
// extension validator (which rejects .bin / .data) accepts all model files.
// Updates model.json paths in-place. Safe to re-run.
import fs from "node:fs";
import path from "node:path";

const MODEL_DIR = "public/models/nsfwjs";
const modelJsonPath = path.join(MODEL_DIR, "model.json");
const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, "utf8"));

let changed = false;
for (const manifest of modelJson.weightsManifest) {
  manifest.paths = manifest.paths.map((p) => {
    const srcPath = path.join(MODEL_DIR, p);
    if (!fs.existsSync(srcPath)) {
      console.log(`  skip (not found): ${p}`);
      return p;
    }
    const ext = path.extname(p);
    if (ext === ".json") {
      console.log(`  already converted: ${p}`);
      return p;
    }
    const newName = p.replace(/\.\w+$/, ".json");
    const destPath = path.join(MODEL_DIR, newName);
    const binary = fs.readFileSync(srcPath);
    fs.writeFileSync(destPath, JSON.stringify({ data: binary.toString("base64") }));
    fs.unlinkSync(srcPath);
    console.log(`  ${p} → ${newName}  (${(binary.length / 1024 / 1024).toFixed(1)} MB)`);
    changed = true;
    return newName;
  });
}

if (changed) {
  fs.writeFileSync(modelJsonPath, JSON.stringify(modelJson));
  console.log("model.json paths updated.");
} else {
  console.log("Nothing to convert.");
}
