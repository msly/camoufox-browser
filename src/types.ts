export type Command = {
  id: string;
  action: string;
  [key: string]: unknown;
};

export interface SuccessResponse<T = unknown> {
  id: string;
  success: true;
  data: T;
}

export interface ErrorResponse {
  id: string;
  success: false;
  error: string;
}

export type Response<T = unknown> = SuccessResponse<T> | ErrorResponse;

export type ParseResult =
  | { success: true; command: Command }
  | { success: false; error: string; id?: string };

