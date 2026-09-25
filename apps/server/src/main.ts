import { loadConfig } from "./config";
import { startGateway } from "./gateway";
import { createProviders } from "./providers";

const config = loadConfig();
const providers = createProviders(config);
const gateway = await startGateway(config, { sttFactory: providers.sttFactory });
console.log(`SnowSpeak server ouvindo em ${config.host}:${config.port} (ws em /ws, tom de teste em /tone)`);
console.log(providers.description);

const shutdown = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
