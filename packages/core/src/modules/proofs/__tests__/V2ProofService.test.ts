import type { AgentContext } from '../../../agent'
import type { Wallet } from '../../../wallet/Wallet'
import type { ProofStateChangedEvent } from '../ProofEvents'
import type { CustomProofTags } from '../repository/ProofExchangeRecord'

import { Subject } from 'rxjs'

import { getAgentConfig, getAgentContext, getMockConnection, mockFunction } from '../../../../tests/helpers'
import { EventEmitter } from '../../../agent/EventEmitter'
import { InboundMessageContext } from '../../../agent/models/InboundMessageContext'
import { Attachment, AttachmentData } from '../../../decorators/attachment/Attachment'
import { DidCommMessageRepository } from '../../../storage'
import { ConnectionService, DidExchangeState } from '../../connections'
import { IndyLedgerService } from '../../ledger/services/IndyLedgerService'
import { ProofEventTypes } from '../ProofEvents'
import { PresentationProblemReportReason } from '../errors/PresentationProblemReportReason'
import { V2_INDY_PRESENTATION, V2_INDY_PRESENTATION_REQUEST } from '../formats/ProofFormatConstants'
import { IndyProofFormatService } from '../formats/indy/IndyProofFormatService'
import { ProofState } from '../models/ProofState'
import { V2ProofService } from '../protocol/v2/V2ProofService'
import { V2PresentationProblemReportMessage, V2RequestPresentationMessage } from '../protocol/v2/messages'
import { ProofExchangeRecord } from '../repository/ProofExchangeRecord'
import { ProofRepository } from '../repository/ProofRepository'

import { credDef } from './fixtures'

// Mock classes
jest.mock('../repository/ProofRepository')
jest.mock('../../../modules/ledger/services/IndyLedgerService')
jest.mock('../../indy/services/IndyHolderService')
jest.mock('../../indy/services/IndyIssuerService')
jest.mock('../../indy/services/IndyVerifierService')
jest.mock('../../connections/services/ConnectionService')
jest.mock('../../../storage/Repository')

// Mock typed object
const ProofRepositoryMock = ProofRepository as jest.Mock<ProofRepository>
const IndyLedgerServiceMock = IndyLedgerService as jest.Mock<IndyLedgerService>
const connectionServiceMock = ConnectionService as jest.Mock<ConnectionService>
const didCommMessageRepositoryMock = DidCommMessageRepository as jest.Mock<DidCommMessageRepository>
const indyProofFormatServiceMock = IndyProofFormatService as jest.Mock<IndyProofFormatService>

const connection = getMockConnection({
  id: '123',
  state: DidExchangeState.Completed,
})

const requestAttachment = new Attachment({
  id: 'abdc8b63-29c6-49ad-9e10-98f9d85db9a2',
  mimeType: 'application/json',
  data: new AttachmentData({
    base64:
      'eyJuYW1lIjogIlByb29mIHJlcXVlc3QiLCAibm9uX3Jldm9rZWQiOiB7ImZyb20iOiAxNjQwOTk1MTk5LCAidG8iOiAxNjQwOTk1MTk5fSwgIm5vbmNlIjogIjEiLCAicmVxdWVzdGVkX2F0dHJpYnV0ZXMiOiB7ImFkZGl0aW9uYWxQcm9wMSI6IHsibmFtZSI6ICJmYXZvdXJpdGVEcmluayIsICJub25fcmV2b2tlZCI6IHsiZnJvbSI6IDE2NDA5OTUxOTksICJ0byI6IDE2NDA5OTUxOTl9LCAicmVzdHJpY3Rpb25zIjogW3siY3JlZF9kZWZfaWQiOiAiV2dXeHF6dHJOb29HOTJSWHZ4U1RXdjozOkNMOjIwOnRhZyJ9XX19LCAicmVxdWVzdGVkX3ByZWRpY2F0ZXMiOiB7fSwgInZlcnNpb24iOiAiMS4wIn0=',
  }),
})

// A record is deserialized to JSON when it's stored into the storage. We want to simulate this behaviour for `offer`
// object to test our service would behave correctly. We use type assertion for `offer` attribute to `any`.
const mockProofExchangeRecord = ({
  state,
  threadId,
  connectionId,
  tags,
  id,
}: {
  state?: ProofState
  requestMessage?: V2RequestPresentationMessage
  tags?: CustomProofTags
  threadId?: string
  connectionId?: string
  id?: string
} = {}) => {
  const requestPresentationMessage = new V2RequestPresentationMessage({
    attachmentInfo: [
      {
        format: {
          attachmentId: 'abdc8b63-29c6-49ad-9e10-98f9d85db9a2',
          format: V2_INDY_PRESENTATION,
        },
        attachment: requestAttachment,
      },
    ],
    comment: 'some comment',
  })

  const proofRecord = new ProofExchangeRecord({
    protocolVersion: 'v2',
    id,
    state: state || ProofState.RequestSent,
    threadId: threadId ?? requestPresentationMessage.id,
    connectionId: connectionId ?? '123',
    tags,
  })

  return proofRecord
}

describe('V2ProofService', () => {
  let proofRepository: ProofRepository
  let proofService: V2ProofService
  let ledgerService: IndyLedgerService
  let wallet: Wallet
  let eventEmitter: EventEmitter
  let connectionService: ConnectionService
  let didCommMessageRepository: DidCommMessageRepository
  let indyProofFormatService: IndyProofFormatService
  let agentContext: AgentContext

  beforeEach(() => {
    agentContext = getAgentContext()
    const agentConfig = getAgentConfig('V2ProofServiceTest')
    proofRepository = new ProofRepositoryMock()
    ledgerService = new IndyLedgerServiceMock()
    eventEmitter = new EventEmitter(agentConfig.agentDependencies, new Subject())
    connectionService = new connectionServiceMock()
    didCommMessageRepository = new didCommMessageRepositoryMock()
    indyProofFormatService = new indyProofFormatServiceMock()

    proofService = new V2ProofService(
      agentConfig,
      connectionService,
      proofRepository,
      didCommMessageRepository,
      eventEmitter,
      indyProofFormatService,
      wallet
    )

    mockFunction(ledgerService.getCredentialDefinition).mockReturnValue(Promise.resolve(credDef))
  })

  describe('processProofRequest', () => {
    let presentationRequest: V2RequestPresentationMessage
    let messageContext: InboundMessageContext<V2RequestPresentationMessage>

    beforeEach(() => {
      presentationRequest = new V2RequestPresentationMessage({
        attachmentInfo: [
          {
            format: {
              attachmentId: 'abdc8b63-29c6-49ad-9e10-98f9d85db9a2',
              format: V2_INDY_PRESENTATION_REQUEST,
            },
            attachment: requestAttachment,
          },
        ],
        comment: 'Proof Request',
      })
      messageContext = new InboundMessageContext(presentationRequest, { agentContext, connection })
    })

    test(`creates and return proof record in ${ProofState.PresentationReceived} state with offer, without thread ID`, async () => {
      const repositorySaveSpy = jest.spyOn(proofRepository, 'save')

      // when
      const returnedProofExchangeRecord = await proofService.processRequest(messageContext)

      // then
      const expectedProofExchangeRecord = {
        type: ProofExchangeRecord.type,
        id: expect.any(String),
        createdAt: expect.any(Date),
        state: ProofState.RequestReceived,
        threadId: presentationRequest.id,
        connectionId: connection.id,
      }
      expect(repositorySaveSpy).toHaveBeenCalledTimes(1)
      const [[, createdProofExchangeRecord]] = repositorySaveSpy.mock.calls
      expect(createdProofExchangeRecord).toMatchObject(expectedProofExchangeRecord)
      expect(returnedProofExchangeRecord).toMatchObject(expectedProofExchangeRecord)
    })

    test(`emits stateChange event with ${ProofState.RequestReceived}`, async () => {
      const eventListenerMock = jest.fn()
      eventEmitter.on<ProofStateChangedEvent>(ProofEventTypes.ProofStateChanged, eventListenerMock)

      // when
      await proofService.processRequest(messageContext)

      // then
      expect(eventListenerMock).toHaveBeenCalledWith({
        type: 'ProofStateChanged',
        metadata: {
          contextCorrelationId: 'mock',
        },
        payload: {
          previousState: null,
          proofRecord: expect.objectContaining({
            state: ProofState.RequestReceived,
          }),
        },
      })
    })
  })

  describe('createProblemReport', () => {
    const threadId = 'fd9c5ddb-ec11-4acd-bc32-540736249746'
    let proof: ProofExchangeRecord

    beforeEach(() => {
      proof = mockProofExchangeRecord({
        state: ProofState.RequestReceived,
        threadId,
        connectionId: 'b1e2f039-aa39-40be-8643-6ce2797b5190',
      })
    })

    test('returns problem report message base once get error', async () => {
      // given
      mockFunction(proofRepository.getById).mockReturnValue(Promise.resolve(proof))

      // when
      const presentationProblemReportMessage = await new V2PresentationProblemReportMessage({
        description: {
          en: 'Indy error',
          code: PresentationProblemReportReason.Abandoned,
        },
      })

      presentationProblemReportMessage.setThread({ threadId })
      // then
      expect(presentationProblemReportMessage.toJSON()).toMatchObject({
        '@id': expect.any(String),
        '@type': 'https://didcomm.org/present-proof/2.0/problem-report',
        '~thread': {
          thid: 'fd9c5ddb-ec11-4acd-bc32-540736249746',
        },
      })
    })
  })

  describe('processProblemReport', () => {
    let proof: ProofExchangeRecord
    let messageContext: InboundMessageContext<V2PresentationProblemReportMessage>
    beforeEach(() => {
      proof = mockProofExchangeRecord({
        state: ProofState.RequestReceived,
      })

      const presentationProblemReportMessage = new V2PresentationProblemReportMessage({
        description: {
          en: 'Indy error',
          code: PresentationProblemReportReason.Abandoned,
        },
      })
      presentationProblemReportMessage.setThread({ threadId: 'somethreadid' })
      messageContext = new InboundMessageContext(presentationProblemReportMessage, { agentContext, connection })
    })

    test(`updates problem report error message and returns proof record`, async () => {
      const repositoryUpdateSpy = jest.spyOn(proofRepository, 'update')

      // given
      mockFunction(proofRepository.getSingleByQuery).mockReturnValue(Promise.resolve(proof))

      // when
      const returnedCredentialRecord = await proofService.processProblemReport(messageContext)

      // then
      const expectedCredentialRecord = {
        errorMessage: 'abandoned: Indy error',
      }
      expect(proofRepository.getSingleByQuery).toHaveBeenNthCalledWith(1, agentContext, {
        threadId: 'somethreadid',
        connectionId: connection.id,
      })
      expect(repositoryUpdateSpy).toHaveBeenCalledTimes(1)
      const [[, updatedCredentialRecord]] = repositoryUpdateSpy.mock.calls
      expect(updatedCredentialRecord).toMatchObject(expectedCredentialRecord)
      expect(returnedCredentialRecord).toMatchObject(expectedCredentialRecord)
    })
  })
})
