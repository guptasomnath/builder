import fs from "fs";
import fsAsync from "fs/promises";
import path from "path";
import { spawn, execSync } from "child_process";
import yaml from "js-yaml";

const DOCKER_IMAGES_FOLDER = "docker-images";
const TEMP_FOLDER_PATH = `${process.cwd()}/user-uploads`;
const TAR_OUTPUT_PATH = `${TEMP_FOLDER_PATH}/${DOCKER_IMAGES_FOLDER}`;
const CONFIG_FILE_PATH = path.join(process.cwd(), "../builder.conf.json");

const loadConfig = () => {
  if (!fs.existsSync(CONFIG_FILE_PATH)) {
    console.error("Unable to find builder.conf.json:", CONFIG_FILE_PATH);
    process.exit(1);
  }

  const { endCommands, dockerComposePath, keepFiles, sshKeyPath, serverInfo } =
    JSON.parse(fs.readFileSync(CONFIG_FILE_PATH).toString());

  if (!serverInfo) {
    console.error("serverInfo is required: 'username', 'ip', 'workingDir'");
    process.exit(1);
  }

  for (const field of ["username", "ip", "workingDir"]) {
    if (!serverInfo[field]) {
      console.error(`serverInfo.${field} is required`);
      process.exit(1);
    }
  }

  return {
    endCommands: endCommands ?? [],
    dockerComposePath,
    keepFiles: keepFiles ?? [],
    sshKeyPath: sshKeyPath ? path.join(process.cwd(), "../", sshKeyPath) : undefined,
    serverInfo: {
      username: serverInfo.username,
      ip: serverInfo.ip,
      workingDir: serverInfo.workingDir,
    },
  };
};

const parseBuiltImageNames = (dockerComposePath) => {
  try {
    const fileContents = fs.readFileSync(dockerComposePath, "utf8");
    const data = yaml.load(fileContents);
    const images = [];

    Object.values(data.services).forEach((service) => {
      if (service.build !== undefined && service.image !== undefined) {
        images.push(service.image);
      }
    });

    console.log(`Found build images: ${images.join(", ")}`);
    return images;
  } catch (e) {
    console.error("Failed to parse docker-compose YAML:", e);
    process.exit(1);
  }
};

const buildDockerImages = (config, extraArgs) => {
  return new Promise((resolve) => {
    const composePath = path.join(process.cwd(), "../", config.dockerComposePath);

    if (!fs.existsSync(composePath)) {
      console.error("Unable to find docker-compose file:", composePath);
      process.exit(1);
    }

    const builtImages = parseBuiltImageNames(composePath);
    const builder = spawn("docker", ["compose", "build", ...extraArgs]);

    builder.stdout.on("data", (data) => console.log(data.toString()));
    builder.stderr.on("data", (data) => console.error(data.toString()));

    builder.on("close", (code) => {
      if (code !== 0) process.exit(code);

      if (builtImages.length === 0) {
        console.error("No custom docker images found in docker-compose.yml");
        process.exit(1);
      }

      resolve(builtImages);
    });
  });
};

const convertToTarFiles = async (builtImages) => {
  console.log(`Saving images as .tar files: ${builtImages.join(", ")}`);
  await fsAsync.mkdir(TAR_OUTPUT_PATH, { recursive: true });

  const tarFileNames = [];

  for (const image of builtImages) {
    const fileName = image.replace(/[:/]/g, "_") + ".tar";
    const outputPath = path.join(TAR_OUTPUT_PATH, fileName);
    try {
      console.log(`Saving ${image} → ${outputPath}...`);
      execSync(`docker save -o "${outputPath}" "${image}"`);
      tarFileNames.push(fileName);
      console.log(`Saved ${image}`);
    } catch (error) {
      console.error(`Failed to save ${image}:`, error.message);
      process.exit(1);
    }
  }

  return tarFileNames;
};

const resolveKeepFiles = (keepFiles) => {
  return keepFiles.map((file) => {
    const absolutePath = path.join(process.cwd(), "../", file);
    if (!fs.existsSync(absolutePath)) {
      console.error(`Unable to find file: ${file}`);
      process.exit(1);
    }
    return absolutePath;
  });
};

const stageFilesForUpload = async (keepFiles, absolutePaths) => {
  const stagingPaths = [];

  for (let i = 0; i < keepFiles.length; i++) {
    await fsAsync.cp(absolutePaths[i], `${TEMP_FOLDER_PATH}/${keepFiles[i]}`, {
      recursive: true,
    });

    const lastSlashIndex = keepFiles[i].lastIndexOf("/");
    if (lastSlashIndex !== -1) {
      stagingPaths.push(`${TEMP_FOLDER_PATH}/${keepFiles[i].slice(0, lastSlashIndex)}`);
    } else {
      stagingPaths.push(`${TEMP_FOLDER_PATH}/${keepFiles[i]}`);
    }
  }

  stagingPaths.push(TAR_OUTPUT_PATH);
  return stagingPaths;
};

const uploadFilesToServer = (stagingPaths, config) => {
  return new Promise((resolve) => {
    const scpArgs = [
      "-v",
      "-r",
      ...stagingPaths,
      `${config.serverInfo.username}@${config.serverInfo.ip}:${config.serverInfo.workingDir}/`,
    ];

    if (config.sshKeyPath) {
      scpArgs.unshift("-i", config.sshKeyPath);
    }

    const upload = spawn("scp", scpArgs);

    upload.stdout.on("data", (data) => console.log(data.toString()));
    upload.stderr.on("data", (data) => console.error(data.toString()));
    upload.on("close", resolve);
  });
};

const executeRemoteDeploy = (tarFileNames, config) => {
  return new Promise((resolve) => {
    const remoteCommands = [
      `cd ${config.serverInfo.workingDir}/${DOCKER_IMAGES_FOLDER}`,
      ...tarFileNames.map((filename) => `docker load -i ${filename}`),
      "docker compose up -d",
      ...config.endCommands,
    ].join(" && ");

    const sshArgs = [
      `${config.serverInfo.username}@${config.serverInfo.ip}`,
      remoteCommands,
    ];

    if (config.sshKeyPath) {
      sshArgs.unshift("-i", config.sshKeyPath);
    }

    const ssh = spawn("ssh", sshArgs);

    ssh.stdout.on("data", (data) => console.log(data.toString()));
    ssh.stderr.on("data", (data) => console.error(data.toString()));
    ssh.on("close", resolve);
  });
};

const main = async () => {
  const config = loadConfig();
  const extraArgs = process.argv.slice(2);

  const builtImages = await buildDockerImages(config, extraArgs);
  const tarFileNames = await convertToTarFiles(builtImages);

  const absolutePaths = resolveKeepFiles(config.keepFiles);
  const stagingPaths = await stageFilesForUpload(config.keepFiles, absolutePaths);

  await uploadFilesToServer(stagingPaths, config);
  const exitCode = await executeRemoteDeploy(tarFileNames, config);

  try {
    await fsAsync.rm(TEMP_FOLDER_PATH, { recursive: true, force: true });
  } catch (err) {
    console.error("Failed to delete temp folder:", err);
  }

  console.log("Deploy complete. Exit code:", exitCode);
  process.exit(exitCode);
};

main();
