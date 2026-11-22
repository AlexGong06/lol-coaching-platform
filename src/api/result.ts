// The shape every handler in this directory returns. One definition, because three
// copies of it were starting to look like three different contracts.

export interface ApiResult {
  status: number;
  body: unknown;
}
