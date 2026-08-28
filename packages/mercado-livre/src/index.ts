export { MercadoLivreApiError } from "./errors.js";
export type { MercadoLivreApiErrorOptions, MercadoLivreErrorClass } from "./errors.js";

export { classifyStatus, computeBackoffDelayMs, parseRetryAfterMs } from "./retry.js";
export type { BackoffOptions, ClassifyStatusOptions } from "./retry.js";

export {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeCodeForToken,
  refreshAccessToken,
  tokenErrorBodySchema,
  tokenResponseSchema,
} from "./oauth.js";
export type {
  BuildAuthorizationUrlOptions,
  MercadoLivreOAuthConfig,
  PkcePair,
  RequestTokenOptions,
  TokenResponse,
} from "./oauth.js";

export { createMercadoLivreClient } from "./http-client.js";
export type {
  HttpMethod,
  MercadoLivreClient,
  MercadoLivreClientConfig,
  RequestOptions,
} from "./http-client.js";

export { paginateOffset } from "./pagination.js";
export type { OffsetPage, PaginateOffsetOptions, PagingInfo } from "./pagination.js";

export {
  classifySender,
  conversationReplyState,
  conversationStatusSchema,
  fetchMessageDetail,
  fetchPackMessages,
  fetchUnreadConversations,
  inferConversationKind,
  mapPackMessagesToSupportProjection,
  messageBodyState,
  messageDetailSchema,
  MESSAGING_AGENT_USER_IDS,
  packMessageSchema,
  packMessagesPageSchema,
  parseConversationResource,
  toMessageConversationLocator,
  unreadConversationsSchema,
} from "./messages.js";
export type {
  FetchMessageDetailOptions,
  FetchPackMessagesOptions,
  FetchUnreadConversationsOptions,
  MessageConversationLocator,
  PackMessage,
  PackMessagesPage,
  SupportConversationCaseProjection,
  SupportConversationMessageProjection,
  SupportConversationProjection,
  SupportConversationReference,
  SupportMessageBodyState,
  SupportSenderKind,
  UnreadConversations,
} from "./messages.js";

export {
  fetchReceivedQuestion,
  fetchReceivedQuestionsPage,
  mapQuestionToSupportProjection,
  postQuestionAnswer,
  questionAnswerResultSchema,
  questionAnswerStatusSchema,
  questionStatusSchema,
  receivedQuestionSchema,
  receivedQuestionsPageSchema,
} from "./questions.js";
export type {
  FetchReceivedQuestionOptions,
  FetchReceivedQuestionsPageOptions,
  PostQuestionAnswerOptions,
  QuestionAnswerResult,
  ReceivedQuestion,
  ReceivedQuestionsPage,
  SupportQuestionBodyState,
  SupportQuestionCaseProjection,
  SupportQuestionMessageProjection,
  SupportQuestionProjection,
} from "./questions.js";

export { decryptToken, encryptToken, loadEncryptionKey } from "./token-cipher.js";

export {
  ITEMS_MULTIGET_MAX_IDS,
  SELLER_ITEMS_MAX_LIMIT,
  chunkItemIds,
  getItemsBatch,
  itemsMultigetEntrySchema,
  itemsMultigetSchema,
  scanSellerItems,
  sellerItemsScanPageSchema,
} from "./items.js";
export type {
  GetItemsBatchOptions,
  ItemsMultigetEntry,
  ScanSellerItemsOptions,
  SellerItemsScanPage,
} from "./items.js";
