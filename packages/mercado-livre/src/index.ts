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
  fetchReceivedQuestion,
  mapQuestionToSupportProjection,
  questionAnswerStatusSchema,
  questionStatusSchema,
  receivedQuestionSchema,
  receivedQuestionsPageSchema,
} from "./questions.js";
export type {
  FetchReceivedQuestionOptions,
  ReceivedQuestion,
  ReceivedQuestionsPage,
  SupportQuestionBodyState,
  SupportQuestionCaseProjection,
  SupportQuestionMessageProjection,
  SupportQuestionProjection,
} from "./questions.js";

export { decryptToken, encryptToken, loadEncryptionKey } from "./token-cipher.js";
