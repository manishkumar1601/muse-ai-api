export interface NoiseTransportFrame { chunkId?: number | bigint; chunkIndex?: number; totalChunks?: number; payload?: Uint8Array; }
export interface Header { key: string; value: string; }
export interface ApplicationRequest { verb?: string; path?: string; headers?: Header[]; body?: Uint8Array; endBody?: boolean; }
export interface ApplicationResponse { status?: number; headers?: Header[]; body?: Uint8Array; endBody?: boolean; }
export interface BodyChunk { data?: Uint8Array; endBody?: boolean; }
export interface Reset { code?: number; reason?: string; }
export interface ServiceFrame { streamId?: number | bigint; request?: ApplicationRequest; response?: ApplicationResponse; bodyChunk?: BodyChunk; reset?: Reset; }
export interface ServiceRequest { service?: number; payload?: Uint8Array; }
export interface ServiceResponse { payload?: Uint8Array; }
export const SERVICE_DAEMON = 0;
export const SERVICE_SENTINEL = 1;
export const SERVICE_VAULT = 2;
export const SERVICE_AUTHD = 3;
