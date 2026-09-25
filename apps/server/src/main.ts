import { loadConfig } from "./config";
import { startGateway } from "./gateway";
import { createFakeSttFactory } from "./stt/fake-stt";

const config = loadConfig();
const gateway = await startGateway(config, { sttFactory: createFakeSttFactory() });
console.log(`SnowSpeak server ouvindo em ${config.host}:${config.port} (ws em /ws, tom de teste em /tone)`);

const shutdown = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
