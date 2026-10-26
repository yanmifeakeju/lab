import { monotonicFactory } from "ulid"

const nextUlid = monotonicFactory()

export type IdPrefix = "prn" | "biz" | "plink" | "pay" | "lpost"

export const createId = (prefix: IdPrefix): string => `${prefix}_${nextUlid()}`
