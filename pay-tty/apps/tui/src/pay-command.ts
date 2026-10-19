/**
 * The command a link's customers pay it with, for the address they reach
 * this server at. The share token is the SSH user name.
 */
export const payCommand = (host: string, port: number) => (shareToken: string) =>
  port === 22 ? `ssh ${shareToken}@${host}` : `ssh -p ${port} ${shareToken}@${host}`
