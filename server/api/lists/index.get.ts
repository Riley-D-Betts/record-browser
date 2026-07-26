import { useDb } from '../../db'
import { readAllLists } from '../../services/lists'

/** Every editable list with its members, usage counts and any unaccounted values. */
export default defineEventHandler(async () => readAllLists(useDb()))
