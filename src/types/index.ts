export interface Env {
    bucket: R2Bucket;
    ENVIRONMENT?: string;
    KV: KVNamespace;
}
