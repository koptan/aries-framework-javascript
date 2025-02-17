// reflect-metadata used for class-transformer + class-validator
import 'reflect-metadata'

export { MessageReceiver } from './agent/MessageReceiver'
export { Agent } from './agent/Agent'
export { BaseAgent } from './agent/BaseAgent'
export * from './agent'
export type { ModulesMap, DefaultAgentModules, EmptyModuleMap } from './agent/AgentModules'
export { EventEmitter } from './agent/EventEmitter'
export { FeatureRegistry } from './agent/FeatureRegistry'
export { Handler, HandlerInboundMessage } from './agent/Handler'
export * from './agent/models'
export { AgentConfig } from './agent/AgentConfig'
export { AgentMessage } from './agent/AgentMessage'
export { Dispatcher } from './agent/Dispatcher'
export { MessageSender } from './agent/MessageSender'
export type { AgentDependencies } from './agent/AgentDependencies'
export type {
  InitConfig,
  OutboundPackage,
  EncryptedMessage,
  WalletConfig,
  JsonArray,
  JsonObject,
  JsonValue,
} from './types'
export { DidCommMimeType, KeyDerivationMethod } from './types'
export type { FileSystem } from './storage/FileSystem'
export * from './storage/BaseRecord'
export { InMemoryMessageRepository } from './storage/InMemoryMessageRepository'
export { Repository } from './storage/Repository'
export * from './storage/RepositoryEvents'
export { StorageService, Query } from './storage/StorageService'
export { getDirFromFilePath } from './utils/path'
export { InjectionSymbols } from './constants'
export * from './wallet'
export type { TransportSession } from './agent/TransportService'
export { TransportService } from './agent/TransportService'
export { Attachment } from './decorators/attachment/Attachment'
export { ReturnRouteTypes } from './decorators/transport/TransportDecorator'

export * from './plugins'
export * from './transport'
export * from './modules/basic-messages'
export * from './modules/common'
export * from './modules/credentials'
export * from './modules/discover-features'
export * from './modules/problem-reports'
export * from './modules/proofs'
export * from './modules/connections'
export * from './modules/ledger'
export * from './modules/routing'
export * from './modules/oob'
export * from './modules/dids'
export * from './modules/vc'
export { JsonEncoder, JsonTransformer, isJsonObject, isValidJweStructure, TypedArrayEncoder, Buffer } from './utils'
export * from './logger'
export * from './error'
export * from './wallet/error'
export { parseMessageType, IsValidMessageType } from './utils/messageType'
export type { Constructor } from './utils/mixins'
export * from './agent/Events'
export * from './crypto/'

import { parseInvitationUrl } from './utils/parseInvitation'
import { uuid } from './utils/uuid'

const utils = {
  uuid,
  parseInvitationUrl,
}

export { utils }
