// Field names match the protobuf wire names (snake_case) exactly — fromDescriptor() does not camelCase.
export interface NoiseTransportFrame { chunk_id?: number | bigint; chunk_index?: number; total_chunks?: number; payload?: Uint8Array; }
export interface Header { key: string; value: string; }
export interface ApplicationRequest { verb?: string; path?: string; headers?: Header[]; body?: Uint8Array; end_body?: boolean; }
export interface ApplicationResponse { status?: number; headers?: Header[]; body?: Uint8Array; end_body?: boolean; }
export interface BodyChunk { data?: Uint8Array; end_body?: boolean; }
export interface Reset { code?: number; reason?: string; }
export interface ServiceFrame { stream_id?: number | bigint; request?: ApplicationRequest; response?: ApplicationResponse; body_chunk?: BodyChunk; reset?: Reset; }
export interface ServiceRequest { service?: number; payload?: Uint8Array; }
export interface ServiceResponse { payload?: Uint8Array; }
export const SERVICE_DAEMON = 0;
export const SERVICE_SENTINEL = 1;
export const SERVICE_VAULT = 2;
export const SERVICE_AUTHD = 3;
