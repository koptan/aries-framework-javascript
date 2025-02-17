import type { AgentContext } from '../../../../agent'
import type { AgentMessage } from '../../../../agent/AgentMessage'
import type { HandlerInboundMessage } from '../../../../agent/Handler'
import type { InboundMessageContext } from '../../../../agent/models/InboundMessageContext'
import type { ProblemReportMessage } from '../../../problem-reports'
import type {
  AcceptCredentialOptions,
  AcceptOfferOptions,
  AcceptProposalOptions,
  AcceptRequestOptions,
  CreateOfferOptions,
  CreateProposalOptions,
  CreateRequestOptions,
  CredentialProtocolMsgReturnType,
  FormatDataMessagePayload,
  CreateProblemReportOptions,
  GetFormatDataReturn,
  NegotiateOfferOptions,
  NegotiateProposalOptions,
} from '../../CredentialServiceOptions'
import type {
  CredentialFormat,
  CredentialFormatPayload,
  CredentialFormatService,
  CredentialFormatServiceMap,
} from '../../formats'
import type { CredentialFormatSpec } from '../../models/CredentialFormatSpec'

import { Dispatcher } from '../../../../agent/Dispatcher'
import { EventEmitter } from '../../../../agent/EventEmitter'
import { InjectionSymbols } from '../../../../constants'
import { AriesFrameworkError } from '../../../../error'
import { Logger } from '../../../../logger'
import { injectable, inject } from '../../../../plugins'
import { DidCommMessageRepository } from '../../../../storage'
import { uuid } from '../../../../utils/uuid'
import { AckStatus } from '../../../common'
import { ConnectionService } from '../../../connections'
import { RoutingService } from '../../../routing/services/RoutingService'
import { CredentialsModuleConfig } from '../../CredentialsModuleConfig'
import { CredentialProblemReportReason } from '../../errors'
import { IndyCredentialFormatService } from '../../formats/indy/IndyCredentialFormatService'
import { JsonLdCredentialFormatService } from '../../formats/jsonld/JsonLdCredentialFormatService'
import { AutoAcceptCredential, CredentialState } from '../../models'
import { CredentialExchangeRecord, CredentialRepository } from '../../repository'
import { CredentialService } from '../../services/CredentialService'
import { composeAutoAccept } from '../../util/composeAutoAccept'
import { arePreviewAttributesEqual } from '../../util/previewAttributes'

import { CredentialFormatCoordinator } from './CredentialFormatCoordinator'
import {
  V2CredentialAckHandler,
  V2IssueCredentialHandler,
  V2OfferCredentialHandler,
  V2ProposeCredentialHandler,
  V2RequestCredentialHandler,
} from './handlers'
import { V2CredentialProblemReportHandler } from './handlers/V2CredentialProblemReportHandler'
import {
  V2CredentialAckMessage,
  V2CredentialProblemReportMessage,
  V2IssueCredentialMessage,
  V2OfferCredentialMessage,
  V2ProposeCredentialMessage,
  V2RequestCredentialMessage,
} from './messages'

@injectable()
export class V2CredentialService<CFs extends CredentialFormat[] = CredentialFormat[]> extends CredentialService<CFs> {
  private connectionService: ConnectionService
  private credentialFormatCoordinator: CredentialFormatCoordinator<CFs>
  private routingService: RoutingService
  private credentialsModuleConfig: CredentialsModuleConfig
  private formatServiceMap: { [key: string]: CredentialFormatService }

  public constructor(
    connectionService: ConnectionService,
    didCommMessageRepository: DidCommMessageRepository,
    routingService: RoutingService,
    dispatcher: Dispatcher,
    eventEmitter: EventEmitter,
    credentialRepository: CredentialRepository,
    indyCredentialFormatService: IndyCredentialFormatService,
    jsonLdCredentialFormatService: JsonLdCredentialFormatService,
    @inject(InjectionSymbols.Logger) logger: Logger,
    credentialsModuleConfig: CredentialsModuleConfig
  ) {
    super(credentialRepository, didCommMessageRepository, eventEmitter, dispatcher, logger)
    this.connectionService = connectionService
    this.routingService = routingService
    this.credentialFormatCoordinator = new CredentialFormatCoordinator(didCommMessageRepository)
    this.credentialsModuleConfig = credentialsModuleConfig

    // Dynamically build format service map. This will be extracted once services are registered dynamically
    this.formatServiceMap = [indyCredentialFormatService, jsonLdCredentialFormatService].reduce(
      (formatServiceMap, formatService) => ({
        ...formatServiceMap,
        [formatService.formatKey]: formatService,
      }),
      {}
    ) as CredentialFormatServiceMap<CFs>

    this.registerHandlers()
  }

  /**
   * The version of the issue credential protocol this service supports
   */
  public readonly version = 'v2' as const

  public getFormatServiceForRecordType(credentialRecordType: CFs[number]['credentialRecordType']) {
    const formatService = this.formatServiceMap[credentialRecordType]

    if (!formatService) {
      throw new AriesFrameworkError(
        `No format service found for credential record type ${credentialRecordType} in v2 credential service`
      )
    }

    return formatService
  }

  /**
   * Create a {@link V2ProposeCredentialMessage} not bound to an existing credential exchange.
   *
   * @param proposal The ProposeCredentialOptions object containing the important fields for the credential message
   * @returns Object containing proposal message and associated credential record
   *
   */
  public async createProposal(
    agentContext: AgentContext,
    { connection, credentialFormats, comment, autoAcceptCredential }: CreateProposalOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<AgentMessage>> {
    this.logger.debug('Get the Format Service and Create Proposal Message')

    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to create proposal. No supported formats`)
    }

    const credentialRecord = new CredentialExchangeRecord({
      connectionId: connection.id,
      threadId: uuid(),
      state: CredentialState.ProposalSent,
      autoAcceptCredential,
      protocolVersion: 'v2',
    })

    const proposalMessage = await this.credentialFormatCoordinator.createProposal(agentContext, {
      credentialFormats,
      credentialRecord,
      formatServices,
      comment,
    })

    this.logger.debug('Save record and emit state change event')
    await this.credentialRepository.save(agentContext, credentialRecord)
    this.emitStateChangedEvent(agentContext, credentialRecord, null)

    return { credentialRecord, message: proposalMessage }
  }

  /**
   * Method called by {@link V2ProposeCredentialHandler} on reception of a propose credential message
   * We do the necessary processing here to accept the proposal and do the state change, emit event etc.
   * @param messageContext the inbound propose credential message
   * @returns credential record appropriate for this incoming message (once accepted)
   */
  public async processProposal(
    messageContext: InboundMessageContext<V2ProposeCredentialMessage>
  ): Promise<CredentialExchangeRecord> {
    const { message: proposalMessage, connection } = messageContext

    this.logger.debug(`Processing credential proposal with id ${proposalMessage.id}`)

    let credentialRecord = await this.findByThreadAndConnectionId(
      messageContext.agentContext,
      proposalMessage.threadId,
      connection?.id
    )

    const formatServices = this.getFormatServicesFromMessage(proposalMessage.formats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to process proposal. No supported formats`)
    }

    // credential record already exists
    if (credentialRecord) {
      const proposalCredentialMessage = await this.didCommMessageRepository.findAgentMessage(
        messageContext.agentContext,
        {
          associatedRecordId: credentialRecord.id,
          messageClass: V2ProposeCredentialMessage,
        }
      )
      const offerCredentialMessage = await this.didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialRecord.id,
        messageClass: V2OfferCredentialMessage,
      })

      // Assert
      credentialRecord.assertProtocolVersion('v2')
      credentialRecord.assertState(CredentialState.OfferSent)
      this.connectionService.assertConnectionOrServiceDecorator(messageContext, {
        previousReceivedMessage: proposalCredentialMessage ?? undefined,
        previousSentMessage: offerCredentialMessage ?? undefined,
      })

      await this.credentialFormatCoordinator.processProposal(messageContext.agentContext, {
        credentialRecord,
        formatServices,
        message: proposalMessage,
      })

      await this.updateState(messageContext.agentContext, credentialRecord, CredentialState.ProposalReceived)

      return credentialRecord
    } else {
      // Assert
      this.connectionService.assertConnectionOrServiceDecorator(messageContext)

      // No credential record exists with thread id
      credentialRecord = new CredentialExchangeRecord({
        connectionId: connection?.id,
        threadId: proposalMessage.threadId,
        state: CredentialState.ProposalReceived,
        protocolVersion: 'v2',
      })

      await this.credentialFormatCoordinator.processProposal(messageContext.agentContext, {
        credentialRecord,
        formatServices,
        message: proposalMessage,
      })

      // Save record and emit event
      await this.credentialRepository.save(messageContext.agentContext, credentialRecord)
      this.emitStateChangedEvent(messageContext.agentContext, credentialRecord, null)

      return credentialRecord
    }
  }

  public async acceptProposal(
    agentContext: AgentContext,
    { credentialRecord, credentialFormats, autoAcceptCredential, comment }: AcceptProposalOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2OfferCredentialMessage>> {
    // Assert
    credentialRecord.assertProtocolVersion('v2')
    credentialRecord.assertState(CredentialState.ProposalReceived)

    // Use empty credentialFormats if not provided to denote all formats should be accepted
    let formatServices = this.getFormatServices(credentialFormats ?? {})

    // if no format services could be extracted from the credentialFormats
    // take all available format services from the proposal message
    if (formatServices.length === 0) {
      const proposalMessage = await this.didCommMessageRepository.getAgentMessage(agentContext, {
        associatedRecordId: credentialRecord.id,
        messageClass: V2ProposeCredentialMessage,
      })

      formatServices = this.getFormatServicesFromMessage(proposalMessage.formats)
    }

    // If the format services list is still empty, throw an error as we don't support any
    // of the formats
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(
        `Unable to accept proposal. No supported formats provided as input or in proposal message`
      )
    }

    const offerMessage = await this.credentialFormatCoordinator.acceptProposal(agentContext, {
      credentialRecord,
      formatServices,
      comment,
      credentialFormats,
    })

    credentialRecord.autoAcceptCredential = autoAcceptCredential ?? credentialRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialRecord, CredentialState.OfferSent)

    return { credentialRecord, message: offerMessage }
  }

  /**
   * Negotiate a credential proposal as issuer (by sending a credential offer message) to the connection
   * associated with the credential record.
   *
   * @param options configuration for the offer see {@link NegotiateProposalOptions}
   * @returns Credential exchange record associated with the credential offer
   *
   */
  public async negotiateProposal(
    agentContext: AgentContext,
    { credentialRecord, credentialFormats, autoAcceptCredential, comment }: NegotiateProposalOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2OfferCredentialMessage>> {
    // Assert
    credentialRecord.assertProtocolVersion('v2')
    credentialRecord.assertState(CredentialState.ProposalReceived)

    if (!credentialRecord.connectionId) {
      throw new AriesFrameworkError(
        `No connectionId found for credential record '${credentialRecord.id}'. Connection-less issuance does not support negotiation.`
      )
    }

    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to create offer. No supported formats`)
    }

    const offerMessage = await this.credentialFormatCoordinator.createOffer(agentContext, {
      formatServices,
      credentialFormats,
      credentialRecord,
      comment,
    })

    credentialRecord.autoAcceptCredential = autoAcceptCredential ?? credentialRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialRecord, CredentialState.OfferSent)

    return { credentialRecord, message: offerMessage }
  }

  /**
   * Create a {@link V2OfferCredentialMessage} as beginning of protocol process. If no connectionId is provided, the
   * exchange will be created without a connection for usage in oob and connection-less issuance.
   *
   * @param formatService {@link CredentialFormatService} the format service object containing format-specific logic
   * @param options attributes of the original offer
   * @returns Object containing offer message and associated credential record
   *
   */
  public async createOffer(
    agentContext: AgentContext,
    { credentialFormats, autoAcceptCredential, comment, connection }: CreateOfferOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2OfferCredentialMessage>> {
    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to create offer. No supported formats`)
    }

    const credentialRecord = new CredentialExchangeRecord({
      connectionId: connection?.id,
      threadId: uuid(),
      state: CredentialState.OfferSent,
      autoAcceptCredential,
      protocolVersion: 'v2',
    })

    const offerMessage = await this.credentialFormatCoordinator.createOffer(agentContext, {
      formatServices,
      credentialFormats,
      credentialRecord,
      comment,
    })

    this.logger.debug(`Saving record and emitting state changed for credential exchange record ${credentialRecord.id}`)
    await this.credentialRepository.save(agentContext, credentialRecord)
    this.emitStateChangedEvent(agentContext, credentialRecord, null)

    return { credentialRecord, message: offerMessage }
  }

  /**
   * Method called by {@link V2OfferCredentialHandler} on reception of a offer credential message
   * We do the necessary processing here to accept the offer and do the state change, emit event etc.
   * @param messageContext the inbound offer credential message
   * @returns credential record appropriate for this incoming message (once accepted)
   */
  public async processOffer(
    messageContext: HandlerInboundMessage<V2OfferCredentialHandler>
  ): Promise<CredentialExchangeRecord> {
    const { message: offerMessage, connection } = messageContext

    this.logger.debug(`Processing credential offer with id ${offerMessage.id}`)

    let credentialRecord = await this.findByThreadAndConnectionId(
      messageContext.agentContext,
      offerMessage.threadId,
      connection?.id
    )

    const formatServices = this.getFormatServicesFromMessage(offerMessage.formats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to process offer. No supported formats`)
    }

    // credential record already exists
    if (credentialRecord) {
      const proposeCredentialMessage = await this.didCommMessageRepository.findAgentMessage(
        messageContext.agentContext,
        {
          associatedRecordId: credentialRecord.id,
          messageClass: V2ProposeCredentialMessage,
        }
      )
      const offerCredentialMessage = await this.didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialRecord.id,
        messageClass: V2OfferCredentialMessage,
      })

      credentialRecord.assertProtocolVersion('v2')
      credentialRecord.assertState(CredentialState.ProposalSent)
      this.connectionService.assertConnectionOrServiceDecorator(messageContext, {
        previousReceivedMessage: offerCredentialMessage ?? undefined,
        previousSentMessage: proposeCredentialMessage ?? undefined,
      })

      await this.credentialFormatCoordinator.processOffer(messageContext.agentContext, {
        credentialRecord,
        formatServices,
        message: offerMessage,
      })

      await this.updateState(messageContext.agentContext, credentialRecord, CredentialState.OfferReceived)
      return credentialRecord
    } else {
      // Assert
      this.connectionService.assertConnectionOrServiceDecorator(messageContext)

      // No credential record exists with thread id
      this.logger.debug('No credential record found for offer, creating a new one')
      credentialRecord = new CredentialExchangeRecord({
        connectionId: connection?.id,
        threadId: offerMessage.threadId,
        state: CredentialState.OfferReceived,
        protocolVersion: 'v2',
      })

      await this.credentialFormatCoordinator.processOffer(messageContext.agentContext, {
        credentialRecord,
        formatServices,
        message: offerMessage,
      })

      // Save in repository
      this.logger.debug('Saving credential record and emit offer-received event')
      await this.credentialRepository.save(messageContext.agentContext, credentialRecord)

      this.emitStateChangedEvent(messageContext.agentContext, credentialRecord, null)
      return credentialRecord
    }
  }

  public async acceptOffer(
    agentContext: AgentContext,
    { credentialRecord, autoAcceptCredential, comment, credentialFormats }: AcceptOfferOptions<CFs>
  ) {
    // Assert
    credentialRecord.assertProtocolVersion('v2')
    credentialRecord.assertState(CredentialState.OfferReceived)

    // Use empty credentialFormats if not provided to denote all formats should be accepted
    let formatServices = this.getFormatServices(credentialFormats ?? {})

    // if no format services could be extracted from the credentialFormats
    // take all available format services from the offer message
    if (formatServices.length === 0) {
      const offerMessage = await this.didCommMessageRepository.getAgentMessage(agentContext, {
        associatedRecordId: credentialRecord.id,
        messageClass: V2OfferCredentialMessage,
      })

      formatServices = this.getFormatServicesFromMessage(offerMessage.formats)
    }

    // If the format services list is still empty, throw an error as we don't support any
    // of the formats
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(
        `Unable to accept offer. No supported formats provided as input or in offer message`
      )
    }

    const message = await this.credentialFormatCoordinator.acceptOffer(agentContext, {
      credentialRecord,
      formatServices,
      comment,
      credentialFormats,
    })

    credentialRecord.autoAcceptCredential = autoAcceptCredential ?? credentialRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialRecord, CredentialState.RequestSent)

    return { credentialRecord, message }
  }

  /**
   * Create a {@link ProposePresentationMessage} as response to a received credential offer.
   * To create a proposal not bound to an existing credential exchange, use {@link createProposal}.
   *
   * @param options configuration to use for the proposal
   * @returns Object containing proposal message and associated credential record
   *
   */
  public async negotiateOffer(
    agentContext: AgentContext,
    { credentialRecord, credentialFormats, autoAcceptCredential, comment }: NegotiateOfferOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2ProposeCredentialMessage>> {
    // Assert
    credentialRecord.assertProtocolVersion('v2')
    credentialRecord.assertState(CredentialState.OfferReceived)

    if (!credentialRecord.connectionId) {
      throw new AriesFrameworkError(
        `No connectionId found for credential record '${credentialRecord.id}'. Connection-less issuance does not support negotiation.`
      )
    }

    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to create proposal. No supported formats`)
    }

    const proposalMessage = await this.credentialFormatCoordinator.createProposal(agentContext, {
      formatServices,
      credentialFormats,
      credentialRecord,
      comment,
    })

    credentialRecord.autoAcceptCredential = autoAcceptCredential ?? credentialRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialRecord, CredentialState.ProposalSent)

    return { credentialRecord, message: proposalMessage }
  }

  /**
   * Create a {@link V2RequestCredentialMessage} as beginning of protocol process.
   * @returns Object containing offer message and associated credential record
   *
   */
  public async createRequest(
    agentContext: AgentContext,
    { credentialFormats, autoAcceptCredential, comment, connection }: CreateRequestOptions<CFs>
  ): Promise<CredentialProtocolMsgReturnType<V2RequestCredentialMessage>> {
    const formatServices = this.getFormatServices(credentialFormats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to create request. No supported formats`)
    }

    const credentialRecord = new CredentialExchangeRecord({
      connectionId: connection.id,
      threadId: uuid(),
      state: CredentialState.RequestSent,
      autoAcceptCredential,
      protocolVersion: 'v2',
    })

    const requestMessage = await this.credentialFormatCoordinator.createRequest(agentContext, {
      formatServices,
      credentialFormats,
      credentialRecord,
      comment,
    })

    this.logger.debug(`Saving record and emitting state changed for credential exchange record ${credentialRecord.id}`)
    await this.credentialRepository.save(agentContext, credentialRecord)
    this.emitStateChangedEvent(agentContext, credentialRecord, null)

    return { credentialRecord, message: requestMessage }
  }

  /**
   * Process a received {@link RequestCredentialMessage}. This will not accept the credential request
   * or send a credential. It will only update the existing credential record with
   * the information from the credential request message. Use {@link createCredential}
   * after calling this method to create a credential.
   *z
   * @param messageContext The message context containing a v2 credential request message
   * @returns credential record associated with the credential request message
   *
   */
  public async processRequest(
    messageContext: InboundMessageContext<V2RequestCredentialMessage>
  ): Promise<CredentialExchangeRecord> {
    const { message: requestMessage, connection } = messageContext

    this.logger.debug(`Processing credential request with id ${requestMessage.id}`)

    let credentialRecord = await this.findByThreadAndConnectionId(
      messageContext.agentContext,
      requestMessage.threadId,
      connection?.id
    )

    const formatServices = this.getFormatServicesFromMessage(requestMessage.formats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to process request. No supported formats`)
    }

    // credential record already exists
    if (credentialRecord) {
      const proposalMessage = await this.didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialRecord.id,
        messageClass: V2ProposeCredentialMessage,
      })

      const offerMessage = await this.didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
        associatedRecordId: credentialRecord.id,
        messageClass: V2OfferCredentialMessage,
      })

      // Assert
      credentialRecord.assertProtocolVersion('v2')
      credentialRecord.assertState(CredentialState.OfferSent)
      this.connectionService.assertConnectionOrServiceDecorator(messageContext, {
        previousReceivedMessage: proposalMessage ?? undefined,
        previousSentMessage: offerMessage ?? undefined,
      })

      await this.credentialFormatCoordinator.processRequest(messageContext.agentContext, {
        credentialRecord,
        formatServices,
        message: requestMessage,
      })

      await this.updateState(messageContext.agentContext, credentialRecord, CredentialState.RequestReceived)
      return credentialRecord
    } else {
      // Assert
      this.connectionService.assertConnectionOrServiceDecorator(messageContext)

      // No credential record exists with thread id
      this.logger.debug('No credential record found for request, creating a new one')
      credentialRecord = new CredentialExchangeRecord({
        connectionId: connection?.id,
        threadId: requestMessage.threadId,
        state: CredentialState.RequestReceived,
        protocolVersion: 'v2',
      })

      await this.credentialFormatCoordinator.processRequest(messageContext.agentContext, {
        credentialRecord,
        formatServices,
        message: requestMessage,
      })

      // Save in repository
      this.logger.debug('Saving credential record and emit request-received event')
      await this.credentialRepository.save(messageContext.agentContext, credentialRecord)

      this.emitStateChangedEvent(messageContext.agentContext, credentialRecord, null)
      return credentialRecord
    }
  }

  public async acceptRequest(
    agentContext: AgentContext,
    { credentialRecord, autoAcceptCredential, comment, credentialFormats }: AcceptRequestOptions<CFs>
  ) {
    // Assert
    credentialRecord.assertProtocolVersion('v2')
    credentialRecord.assertState(CredentialState.RequestReceived)

    // Use empty credentialFormats if not provided to denote all formats should be accepted
    let formatServices = this.getFormatServices(credentialFormats ?? {})

    // if no format services could be extracted from the credentialFormats
    // take all available format services from the request message
    if (formatServices.length === 0) {
      const requestMessage = await this.didCommMessageRepository.getAgentMessage(agentContext, {
        associatedRecordId: credentialRecord.id,
        messageClass: V2RequestCredentialMessage,
      })

      formatServices = this.getFormatServicesFromMessage(requestMessage.formats)
    }

    // If the format services list is still empty, throw an error as we don't support any
    // of the formats
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(
        `Unable to accept request. No supported formats provided as input or in request message`
      )
    }
    const message = await this.credentialFormatCoordinator.acceptRequest(agentContext, {
      credentialRecord,
      formatServices,
      comment,
      credentialFormats,
    })

    credentialRecord.autoAcceptCredential = autoAcceptCredential ?? credentialRecord.autoAcceptCredential
    await this.updateState(agentContext, credentialRecord, CredentialState.CredentialIssued)

    return { credentialRecord, message }
  }

  /**
   * Process a received {@link IssueCredentialMessage}. This will not accept the credential
   * or send a credential acknowledgement. It will only update the existing credential record with
   * the information from the issue credential message. Use {@link createAck}
   * after calling this method to create a credential acknowledgement.
   *
   * @param messageContext The message context containing an issue credential message
   *
   * @returns credential record associated with the issue credential message
   *
   */
  public async processCredential(
    messageContext: InboundMessageContext<V2IssueCredentialMessage>
  ): Promise<CredentialExchangeRecord> {
    const { message: credentialMessage, connection } = messageContext

    this.logger.debug(`Processing credential with id ${credentialMessage.id}`)

    const credentialRecord = await this.getByThreadAndConnectionId(
      messageContext.agentContext,
      credentialMessage.threadId,
      connection?.id
    )

    const requestMessage = await this.didCommMessageRepository.getAgentMessage(messageContext.agentContext, {
      associatedRecordId: credentialRecord.id,
      messageClass: V2RequestCredentialMessage,
    })
    const offerMessage = await this.didCommMessageRepository.findAgentMessage(messageContext.agentContext, {
      associatedRecordId: credentialRecord.id,
      messageClass: V2OfferCredentialMessage,
    })

    // Assert
    credentialRecord.assertProtocolVersion('v2')
    credentialRecord.assertState(CredentialState.RequestSent)
    this.connectionService.assertConnectionOrServiceDecorator(messageContext, {
      previousReceivedMessage: offerMessage ?? undefined,
      previousSentMessage: requestMessage,
    })

    const formatServices = this.getFormatServicesFromMessage(requestMessage.formats)
    if (formatServices.length === 0) {
      throw new AriesFrameworkError(`Unable to process credential. No supported formats`)
    }

    await this.credentialFormatCoordinator.processCredential(messageContext.agentContext, {
      credentialRecord,
      formatServices,
      requestMessage: requestMessage,
      message: credentialMessage,
    })

    await this.updateState(messageContext.agentContext, credentialRecord, CredentialState.CredentialReceived)

    return credentialRecord
  }

  /**
   * Create a {@link V2CredentialAckMessage} as response to a received credential.
   *
   * @param credentialRecord The credential record for which to create the credential acknowledgement
   * @returns Object containing credential acknowledgement message and associated credential record
   *
   */
  public async acceptCredential(
    agentContext: AgentContext,
    { credentialRecord }: AcceptCredentialOptions
  ): Promise<CredentialProtocolMsgReturnType<V2CredentialAckMessage>> {
    credentialRecord.assertProtocolVersion('v2')
    credentialRecord.assertState(CredentialState.CredentialReceived)

    // Create message
    const ackMessage = new V2CredentialAckMessage({
      status: AckStatus.OK,
      threadId: credentialRecord.threadId,
    })

    await this.updateState(agentContext, credentialRecord, CredentialState.Done)

    return { message: ackMessage, credentialRecord }
  }

  /**
   * Process a received {@link CredentialAckMessage}.
   *
   * @param messageContext The message context containing a credential acknowledgement message
   * @returns credential record associated with the credential acknowledgement message
   *
   */
  public async processAck(
    messageContext: InboundMessageContext<V2CredentialAckMessage>
  ): Promise<CredentialExchangeRecord> {
    const { message: ackMessage, connection } = messageContext

    this.logger.debug(`Processing credential ack with id ${ackMessage.id}`)

    const credentialRecord = await this.getByThreadAndConnectionId(
      messageContext.agentContext,
      ackMessage.threadId,
      connection?.id
    )
    credentialRecord.connectionId = connection?.id

    const requestMessage = await this.didCommMessageRepository.getAgentMessage(messageContext.agentContext, {
      associatedRecordId: credentialRecord.id,
      messageClass: V2RequestCredentialMessage,
    })

    const credentialMessage = await this.didCommMessageRepository.getAgentMessage(messageContext.agentContext, {
      associatedRecordId: credentialRecord.id,
      messageClass: V2IssueCredentialMessage,
    })

    // Assert
    credentialRecord.assertProtocolVersion('v2')
    credentialRecord.assertState(CredentialState.CredentialIssued)
    this.connectionService.assertConnectionOrServiceDecorator(messageContext, {
      previousReceivedMessage: requestMessage,
      previousSentMessage: credentialMessage,
    })

    // Update record
    await this.updateState(messageContext.agentContext, credentialRecord, CredentialState.Done)

    return credentialRecord
  }

  /**
   * Create a {@link V2CredentialProblemReportMessage} to be sent.
   *
   * @param message message to send
   * @returns a {@link V2CredentialProblemReportMessage}
   *
   */
  public createProblemReport(agentContext: AgentContext, options: CreateProblemReportOptions): ProblemReportMessage {
    return new V2CredentialProblemReportMessage({
      description: {
        en: options.message,
        code: CredentialProblemReportReason.IssuanceAbandoned,
      },
    })
  }

  // AUTO ACCEPT METHODS
  public async shouldAutoRespondToProposal(
    agentContext: AgentContext,
    options: {
      credentialRecord: CredentialExchangeRecord
      proposalMessage: V2ProposeCredentialMessage
    }
  ): Promise<boolean> {
    const { credentialRecord, proposalMessage } = options
    const autoAccept = composeAutoAccept(
      credentialRecord.autoAcceptCredential,
      this.credentialsModuleConfig.autoAcceptCredentials
    )

    // Handle always / never cases
    if (autoAccept === AutoAcceptCredential.Always) return true
    if (autoAccept === AutoAcceptCredential.Never) return false

    const offerMessage = await this.findOfferMessage(agentContext, credentialRecord.id)
    if (!offerMessage) return false

    // NOTE: we take the formats from the offerMessage so we always check all services that we last sent
    // Otherwise we'll only check the formats from the proposal, which could be different from the formats
    // we use.
    const formatServices = this.getFormatServicesFromMessage(offerMessage.formats)

    for (const formatService of formatServices) {
      const offerAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        offerMessage.formats,
        offerMessage.offerAttachments
      )

      const proposalAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        proposalMessage.formats,
        proposalMessage.proposalAttachments
      )

      const shouldAutoRespondToFormat = formatService.shouldAutoRespondToProposal(agentContext, {
        credentialRecord,
        offerAttachment,
        proposalAttachment,
      })
      // If any of the formats return false, we should not auto accept
      if (!shouldAutoRespondToFormat) return false
    }

    // not all formats use the proposal and preview, we only check if they're present on
    // either or both of the messages
    if (proposalMessage.credentialPreview || offerMessage.credentialPreview) {
      // if one of the message doesn't have a preview, we should not auto accept
      if (!proposalMessage.credentialPreview || !offerMessage.credentialPreview) return false

      // Check if preview values match
      return arePreviewAttributesEqual(
        proposalMessage.credentialPreview.attributes,
        offerMessage.credentialPreview.attributes
      )
    }

    return true
  }

  public async shouldAutoRespondToOffer(
    agentContext: AgentContext,
    options: {
      credentialRecord: CredentialExchangeRecord
      offerMessage: V2OfferCredentialMessage
    }
  ): Promise<boolean> {
    const { credentialRecord, offerMessage } = options
    const autoAccept = composeAutoAccept(
      credentialRecord.autoAcceptCredential,
      this.credentialsModuleConfig.autoAcceptCredentials
    )

    // Handle always / never cases
    if (autoAccept === AutoAcceptCredential.Always) return true
    if (autoAccept === AutoAcceptCredential.Never) return false

    const proposalMessage = await this.findProposalMessage(agentContext, credentialRecord.id)
    if (!proposalMessage) return false

    // NOTE: we take the formats from the proposalMessage so we always check all services that we last sent
    // Otherwise we'll only check the formats from the offer, which could be different from the formats
    // we use.
    const formatServices = this.getFormatServicesFromMessage(proposalMessage.formats)

    for (const formatService of formatServices) {
      const offerAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        offerMessage.formats,
        offerMessage.offerAttachments
      )

      const proposalAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        proposalMessage.formats,
        proposalMessage.proposalAttachments
      )

      const shouldAutoRespondToFormat = formatService.shouldAutoRespondToOffer(agentContext, {
        credentialRecord,
        offerAttachment,
        proposalAttachment,
      })

      // If any of the formats return false, we should not auto accept

      if (!shouldAutoRespondToFormat) return false
    }

    // if one of the message doesn't have a preview, we should not auto accept
    if (proposalMessage.credentialPreview || offerMessage.credentialPreview) {
      // Check if preview values match
      return arePreviewAttributesEqual(
        proposalMessage.credentialPreview?.attributes ?? [],
        offerMessage.credentialPreview?.attributes ?? []
      )
    }
    return true
  }

  public async shouldAutoRespondToRequest(
    agentContext: AgentContext,
    options: {
      credentialRecord: CredentialExchangeRecord
      requestMessage: V2RequestCredentialMessage
    }
  ): Promise<boolean> {
    const { credentialRecord, requestMessage } = options
    const autoAccept = composeAutoAccept(
      credentialRecord.autoAcceptCredential,
      this.credentialsModuleConfig.autoAcceptCredentials
    )

    // Handle always / never cases
    if (autoAccept === AutoAcceptCredential.Always) return true
    if (autoAccept === AutoAcceptCredential.Never) return false

    const proposalMessage = await this.findProposalMessage(agentContext, credentialRecord.id)

    const offerMessage = await this.findOfferMessage(agentContext, credentialRecord.id)
    if (!offerMessage) return false

    // NOTE: we take the formats from the offerMessage so we always check all services that we last sent
    // Otherwise we'll only check the formats from the request, which could be different from the formats
    // we use.
    const formatServices = this.getFormatServicesFromMessage(offerMessage.formats)

    for (const formatService of formatServices) {
      const offerAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        offerMessage.formats,
        offerMessage.offerAttachments
      )

      const proposalAttachment = proposalMessage
        ? this.credentialFormatCoordinator.getAttachmentForService(
            formatService,
            proposalMessage.formats,
            proposalMessage.proposalAttachments
          )
        : undefined

      const requestAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        requestMessage.formats,
        requestMessage.requestAttachments
      )

      const shouldAutoRespondToFormat = formatService.shouldAutoRespondToRequest(agentContext, {
        credentialRecord,
        offerAttachment,
        requestAttachment,
        proposalAttachment,
      })

      // If any of the formats return false, we should not auto accept
      if (!shouldAutoRespondToFormat) return false
    }

    return true
  }

  public async shouldAutoRespondToCredential(
    agentContext: AgentContext,
    options: {
      credentialRecord: CredentialExchangeRecord
      credentialMessage: V2IssueCredentialMessage
    }
  ): Promise<boolean> {
    const { credentialRecord, credentialMessage } = options
    const autoAccept = composeAutoAccept(
      credentialRecord.autoAcceptCredential,
      this.credentialsModuleConfig.autoAcceptCredentials
    )

    // Handle always / never cases
    if (autoAccept === AutoAcceptCredential.Always) return true
    if (autoAccept === AutoAcceptCredential.Never) return false

    const proposalMessage = await this.findProposalMessage(agentContext, credentialRecord.id)
    const offerMessage = await this.findOfferMessage(agentContext, credentialRecord.id)

    const requestMessage = await this.findRequestMessage(agentContext, credentialRecord.id)
    if (!requestMessage) return false

    // NOTE: we take the formats from the requestMessage so we always check all services that we last sent
    // Otherwise we'll only check the formats from the credential, which could be different from the formats
    // we use.
    const formatServices = this.getFormatServicesFromMessage(requestMessage.formats)

    for (const formatService of formatServices) {
      const offerAttachment = offerMessage
        ? this.credentialFormatCoordinator.getAttachmentForService(
            formatService,
            offerMessage.formats,
            offerMessage.offerAttachments
          )
        : undefined

      const proposalAttachment = proposalMessage
        ? this.credentialFormatCoordinator.getAttachmentForService(
            formatService,
            proposalMessage.formats,
            proposalMessage.proposalAttachments
          )
        : undefined

      const requestAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        requestMessage.formats,
        requestMessage.requestAttachments
      )

      const credentialAttachment = this.credentialFormatCoordinator.getAttachmentForService(
        formatService,
        credentialMessage.formats,
        credentialMessage.credentialAttachments
      )

      const shouldAutoRespondToFormat = formatService.shouldAutoRespondToCredential(agentContext, {
        credentialRecord,
        offerAttachment,
        credentialAttachment,
        requestAttachment,
        proposalAttachment,
      })

      // If any of the formats return false, we should not auto accept
      if (!shouldAutoRespondToFormat) return false
    }
    return true
  }

  public async findProposalMessage(agentContext: AgentContext, credentialExchangeId: string) {
    return this.didCommMessageRepository.findAgentMessage(agentContext, {
      associatedRecordId: credentialExchangeId,
      messageClass: V2ProposeCredentialMessage,
    })
  }

  public async findOfferMessage(agentContext: AgentContext, credentialExchangeId: string) {
    return await this.didCommMessageRepository.findAgentMessage(agentContext, {
      associatedRecordId: credentialExchangeId,
      messageClass: V2OfferCredentialMessage,
    })
  }

  public async findRequestMessage(agentContext: AgentContext, credentialExchangeId: string) {
    return await this.didCommMessageRepository.findAgentMessage(agentContext, {
      associatedRecordId: credentialExchangeId,
      messageClass: V2RequestCredentialMessage,
    })
  }

  public async findCredentialMessage(agentContext: AgentContext, credentialExchangeId: string) {
    return await this.didCommMessageRepository.findAgentMessage(agentContext, {
      associatedRecordId: credentialExchangeId,
      messageClass: V2IssueCredentialMessage,
    })
  }

  public async getFormatData(agentContext: AgentContext, credentialExchangeId: string): Promise<GetFormatDataReturn> {
    // TODO: we could looking at fetching all record using a single query and then filtering based on the type of the message.
    const [proposalMessage, offerMessage, requestMessage, credentialMessage] = await Promise.all([
      this.findProposalMessage(agentContext, credentialExchangeId),
      this.findOfferMessage(agentContext, credentialExchangeId),
      this.findRequestMessage(agentContext, credentialExchangeId),
      this.findCredentialMessage(agentContext, credentialExchangeId),
    ])

    // Create object with the keys and the message formats/attachments. We can then loop over this in a generic
    // way so we don't have to add the same operation code four times
    const messages = {
      proposal: [proposalMessage?.formats, proposalMessage?.proposalAttachments],
      offer: [offerMessage?.formats, offerMessage?.offerAttachments],
      request: [requestMessage?.formats, requestMessage?.requestAttachments],
      credential: [credentialMessage?.formats, credentialMessage?.credentialAttachments],
    } as const

    const formatData: GetFormatDataReturn = {
      proposalAttributes: proposalMessage?.credentialPreview?.attributes,
      offerAttributes: offerMessage?.credentialPreview?.attributes,
    }

    // We loop through all of the message keys as defined above
    for (const [messageKey, [formats, attachments]] of Object.entries(messages)) {
      // Message can be undefined, so we continue if it is not defined
      if (!formats || !attachments) continue

      // Find all format services associated with the message
      const formatServices = this.getFormatServicesFromMessage(formats)
      const messageFormatData: FormatDataMessagePayload = {}

      // Loop through all of the format services, for each we will extract the attachment data and assign this to the object
      // using the unique format key (e.g. indy)
      for (const formatService of formatServices) {
        const attachment = this.credentialFormatCoordinator.getAttachmentForService(formatService, formats, attachments)

        messageFormatData[formatService.formatKey] = attachment.getDataAsJson()
      }

      formatData[messageKey as Exclude<keyof GetFormatDataReturn, 'proposalAttributes' | 'offerAttributes'>] =
        messageFormatData
    }

    return formatData
  }

  protected registerHandlers() {
    this.logger.debug('Registering V2 handlers')

    this.dispatcher.registerHandler(new V2ProposeCredentialHandler(this, this.logger))

    this.dispatcher.registerHandler(
      new V2OfferCredentialHandler(this, this.routingService, this.didCommMessageRepository, this.logger)
    )

    this.dispatcher.registerHandler(new V2RequestCredentialHandler(this, this.didCommMessageRepository, this.logger))

    this.dispatcher.registerHandler(new V2IssueCredentialHandler(this, this.didCommMessageRepository, this.logger))
    this.dispatcher.registerHandler(new V2CredentialAckHandler(this))
    this.dispatcher.registerHandler(new V2CredentialProblemReportHandler(this))
  }

  /**
   * Get all the format service objects for a given credential format from an incoming message
   * @param messageFormats the format objects containing the format name (eg indy)
   * @return the credential format service objects in an array - derived from format object keys
   */
  private getFormatServicesFromMessage(messageFormats: CredentialFormatSpec[]): CredentialFormatService[] {
    const formatServices = new Set<CredentialFormatService>()

    for (const msg of messageFormats) {
      const service = this.getFormatServiceForFormat(msg.format)
      if (service) formatServices.add(service)
    }

    return Array.from(formatServices)
  }

  /**
   * Get all the format service objects for a given credential format
   * @param credentialFormats the format object containing various optional parameters
   * @return the credential format service objects in an array - derived from format object keys
   */
  private getFormatServices<M extends keyof CredentialFormat['credentialFormats']>(
    credentialFormats: CredentialFormatPayload<CFs, M>
  ): CredentialFormatService[] {
    const formats = new Set<CredentialFormatService>()

    for (const formatKey of Object.keys(credentialFormats)) {
      const formatService = this.getFormatServiceForFormatKey(formatKey)

      if (formatService) formats.add(formatService)
    }

    return Array.from(formats)
  }

  private getFormatServiceForFormatKey(formatKey: string): CredentialFormatService | null {
    if (this.formatServiceMap[formatKey]) {
      return this.formatServiceMap[formatKey]
    }

    return null
  }

  private getFormatServiceForFormat(format: string): CredentialFormatService | null {
    for (const service of Object.values(this.formatServiceMap)) {
      if (service.supportsFormat(format)) return service
    }

    return null
  }
}
