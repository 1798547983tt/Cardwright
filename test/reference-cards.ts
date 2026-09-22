import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Re0 reference card and world book live beside the repository, in ../参考资料, and are only read. A checkout
 * without them skips the tests that need them; CARDWRIGHT_REFERENCE_DIR points somewhere else.
 */
export const REFERENCE_DIR = process.env.CARDWRIGHT_REFERENCE_DIR || fileURLToPath(new URL('../../参考资料/', import.meta.url));
export const RE0_CARD = join(REFERENCE_DIR, '完整的卡', 'json格式的卡', 'Re0：从零开始的异世界生活.json');
export const RE0_PNG = join(REFERENCE_DIR, '完整的卡', 'png格式的卡', 'Re0：从零开始的异世界生活 (1).png');
export const RE0_BOOK = join(REFERENCE_DIR, '世界书部分', '完整的世界书', 'Re0：从零开始的异世界生活世界书.json');
