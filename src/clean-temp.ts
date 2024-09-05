import fs from "fs";
import path from "path";
import { TEMP_DIR } from "./constants.js";

export default function cleanTemp() {
  const allFiles = fs.readdirSync(TEMP_DIR);

  for (const file of allFiles) {
    fs.rmSync(path.join(TEMP_DIR, file), { recursive: true, force: true });
    console.log(`[CLEAN_TEMP] ${file} deleted...`);
  }

  console.log(`[CLEAN_TEMP] ${allFiles.length} files deleted...`);
}
