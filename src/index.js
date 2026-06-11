import fs from "fs";
import fsAsync from "fs/promises";
import path from "path";
import { spawn, execSync } from "child_process";
import yaml from "js-yaml";

const DOCKER_IMAGES_STORAGE_FOLDER = "docker-images"; // read only
const TEMP_FOLDER_PATH = `${process.cwd()}/user-uploads`; // read only
const TAR_FILE_PATH = `${TEMP_FOLDER_PATH}/${DOCKER_IMAGES_STORAGE_FOLDER}`; // read only
const BUILDER_CONFIG_JSON = path.join(process.cwd(), "../builder.conf.json"); // read only

const builtImages = [];
const tarFileNames = [];
const argsCommends = [];
const builderConfig = {
  endCommends: [],
  dockerComposePath: "",
  keepFiles: [],
  sshKeyPath: undefined,
  serverInfo: {
    username: "",
    ip: "",
    workingDir: "",
  },
};

const createAndSetDockerImagesName = (dockerComposePath) => {
  try {
    // Load the file content
    const fileContents = fs.readFileSync(dockerComposePath, "utf8");

    // Parse YAML to a JS object
    const data = yaml.load(fileContents);

    // Access your docker services
    Object.values(data.services).forEach(service => {
      if(service.build !== undefined && service.image !== undefined) {
        builtImages.push(service.image)
      }
    })
    console.log(`Successfully extract build image names form docker yml file ${builtImages.join(" ")}`)
  } catch (e) {
    console.error("Failed to parse YAML:", e);
    process.exit(1);
  }
};

const executeAfterUploadCommends = () => {
  if (tarFileNames.length === 0) {
    console.error("Unable to find tar file names. retry again");
    process.exit(1);
  }

  const args = [
    `${builderConfig.serverInfo.username}@${builderConfig.serverInfo.ip}`,
    `cd ${builderConfig.serverInfo.workingDir}/${DOCKER_IMAGES_STORAGE_FOLDER}`,
    `&& ${tarFileNames.map((filename) => `docker load -i ${filename}`).join(" && ")}`,
    "&& docker compose up -d",
  ];

  if (builderConfig.sshKeyPath) {
    args.unshift("-i", builderConfig.sshKeyPath);
  }

  if (builderConfig.endCommends.length > 0) {
    args.push(`&& ${builderConfig.endCommends.join(" && ")}`);
  }

  const commendExec = spawn("ssh", args);

  commendExec.stdout.on("data", (data) => {
    console.log(data.toString());
  });

  commendExec.stderr.on("data", (data) => {
    console.error(data.toString());
  });

  commendExec.on("close", async (code) => {
    try {
      await fsAsync.rm(TEMP_FOLDER_PATH, {
        recursive: true,
        force: true,
      });
    } catch (err) {
      console.error("Failed to delete temp folder:", err);
    }
    console.log("Files Successfully Uploaded And Executed : ", code);
    process.exit(code);
  });
};

const uploadFilesToServer = async (absloutePaths) => {
  absloutePaths.push(TAR_FILE_PATH);

  const uploadFilesArgs = [
    "-v",
    "-r",
    ...absloutePaths,
    `${builderConfig.serverInfo.username}@${builderConfig.serverInfo.ip}:${builderConfig.serverInfo.workingDir}/`,
  ];

  if (builderConfig.sshKeyPath) {
    uploadFilesArgs.unshift("-i", builderConfig.sshKeyPath);
  }

  const uploadFileSpawn = spawn("scp", uploadFilesArgs);

  uploadFileSpawn.stdout.on("data", (data) => {
    console.log(data.toString());
  });

  uploadFileSpawn.stderr.on("data", (data) => {
    console.error(data.toString());
  });

  uploadFileSpawn.on("close", async () => {
    executeAfterUploadCommends();
  });
};

const createRequiredFolders = async (originalPaths, absloutePaths) => {
  let index = 0;
  for (const abPath of absloutePaths) {
    await fsAsync.cp(abPath, `${TEMP_FOLDER_PATH}/${originalPaths[index]}`, {
      recursive: true,
    });
    index++;
  }

  const createDir = [];

  for (const oriPath of originalPaths) {
    const lastSlaceIndex = oriPath.lastIndexOf("/");
    if (lastSlaceIndex != -1) {
      createDir.push(
        `${TEMP_FOLDER_PATH}/${oriPath.slice(0, oriPath.lastIndexOf("/"))}`,
      );
    } else {
      createDir.push(`${TEMP_FOLDER_PATH}/${oriPath}`);
    }
  }

  uploadFilesToServer(createDir);
};

const arrangeFiles = async () => {
  //verify each file exist or not
  let index = 0;
  const absloutePaths = [];

  for (const file of builderConfig.keepFiles) {
    const filePath = path.join(process.cwd(), `../${file}`);
    if (!fs.existsSync(filePath)) {
      console.error(`Unable to find file path ${file}`);
      process.exit(1);
    }
    absloutePaths.push(filePath);
    index++;
  }

  createRequiredFolders(builderConfig.keepFiles, absloutePaths);
};

const convartTarFile = async () => {
  console.log(`Building .tar file for these images ${builtImages.join(", ")}`);
  const dockerImageOutputPath = `${TEMP_FOLDER_PATH}/docker-images`;
  await fsAsync.mkdir(dockerImageOutputPath, { recursive: true });

  // docker save -o app-images.tar trek_api:latest trek_crm:latest trek_frontend:latest trek_upload:latest
  builtImages.forEach((image) => {
    const fileName = image.replace(/[:/]/g, "_") + ".tar";
    const outputPath = path.join(dockerImageOutputPath, fileName);
    try {
      console.log(`Saving ${image} to ${outputPath}...`);
      // Run the docker save command
      execSync(`docker save -o "${outputPath}" "${image}"`);
      tarFileNames.push(fileName);
      console.log(`Successfully saved ${image}`);
    } catch (error) {
      console.error(`Failed to save ${image}:`, error.message);
      process.exit(1);
    }
  });

  arrangeFiles();
};

const buildDockerImageLocally = () => {
  // build docker file first
  const DOCKER_COMPOSE_PATH = path.join(
    process.cwd(),
    "../",
    builderConfig.dockerComposePath,
  );
  if (!fs.existsSync(DOCKER_COMPOSE_PATH)) {
    console.error("Unable to find docker path : ", DOCKER_COMPOSE_PATH);
    process.exit(1);
  }

  createAndSetDockerImagesName(DOCKER_COMPOSE_PATH);

  const dockerBuilder = spawn("docker", ["compose", "build", ...argsCommends]);

  dockerBuilder.stdout.on("data", (data) => {
    console.log(data.toString());
  });

  dockerBuilder.stderr.on("data", (data) => {
    console.error(data.toString());
  });

  dockerBuilder.on("close", (code) => {
    if (code == 1) {
      process.exit(code);
    }

    if (builtImages.length == 0) {
      console.error("Unable to fild any custom docker image");
      process.exit(1);
    }

    convartTarFile();
  });
};

const main = () => {
  if (!fs.existsSync(BUILDER_CONFIG_JSON)) {
    console.error("Unable to find builder.conf.json : ", BUILDER_CONFIG_JSON);
    process.exit(1);
  }

  const { endCommends, dockerComposePath, keepFiles, sshKeyPath, serverInfo } =
    JSON.parse(fs.readFileSync(BUILDER_CONFIG_JSON).toString());

  builderConfig.endCommends = endCommends;
  builderConfig.dockerComposePath = dockerComposePath;
  builderConfig.keepFiles = keepFiles;
  if (sshKeyPath) {
    builderConfig.sshKeyPath = path.join(process.cwd(), "../", sshKeyPath);
  }

  if (!serverInfo) {
    console.error("Server info is required : 'username', 'ip', 'workingDir'");
    process.exit(1);
  }

  if (!serverInfo.username) {
    console.error("Server info is required : 'username'");
    process.exit(1);
  }

  if (!serverInfo.ip) {
    console.error("Server info is required : 'ip'");
    process.exit(1);
  }

  if (!serverInfo.workingDir) {
    console.error("Server info is required : 'workingDir'");
    process.exit(1);
  }

  builderConfig.serverInfo = {
    username: serverInfo.username,
    ip: serverInfo.ip,
    workingDir: serverInfo.workingDir,
  };

  argsCommends.push(...process.argv.slice(2));
  buildDockerImageLocally();
};

main();