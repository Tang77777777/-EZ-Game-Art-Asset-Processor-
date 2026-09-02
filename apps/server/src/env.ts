/** EZ Game Art Asset Processor 环境变量的统一前缀。 */
const PREFIX = "EZGAMEART_";

/**
 * 读取产品环境变量。
 * @param suffix 不含前缀的部分，如 `GEN_CLI`
 */
export function readEnv(suffix: string): string | undefined {
  return process.env[PREFIX + suffix];
}

/** 便捷形式：trim 后返回，缺失或全空白时返回空串。 */
export function readEnvTrimmed(suffix: string): string {
  return readEnv(suffix)?.trim() ?? "";
}
