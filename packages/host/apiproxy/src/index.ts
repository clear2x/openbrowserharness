/**
 * @deepseek-ai/dsh-host-apiproxy — the API gateway every client shape shares:
 * the ApiProxy contract (api/: types + zod schemas, browser-safe) and the
 * client-side fetch carriers (fetch/: AbstractApiClient + platform subclasses,
 * consumed through the `./client` subpath). The fork trims the host-side proxy
 * pieces the desktop hosts own; extension and web clients consume the contract
 * and the client carriers directly.
 */

import type {} from '@deepseek-ai/dsh-agent-default-model'

export type * from './api/index.ts'
export { RpcId } from './api/rpc.ts'
