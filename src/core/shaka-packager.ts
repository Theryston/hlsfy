import path from "path";

const commandNames: any = {
  linux: {
    x64: "packager-linux-x64",
    arm64: "packager-linux-arm64",
  },
  darwin: {
    x64: "packager-osx-x64",
    arm64: "packager-osx-arm64",
  },
  win32: {
    x64: "packager-win-x64.exe",
  },
};

export default function getShakaPath() {
  if (!(process.platform in commandNames)) {
    throw new Error("Platform not supported: " + process.platform);
  }

  if (!(process.arch in commandNames[process.platform])) {
    throw new Error(
      "Architecture not supported: " + process.platform + "/" + process.arch,
    );
  }

  const commandName = commandNames[process.platform][process.arch];
  const binaryPath = path.resolve(
    process.cwd(),
    "shaka-packager-bin",
    commandName,
  );

  return binaryPath;
}
