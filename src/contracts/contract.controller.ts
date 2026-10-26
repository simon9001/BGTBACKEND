import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import { ContractQuerySchema, CreateContractSchema, UpdateContractSchema } from '../validators/contract.validators.js';
import { getProcurementRowService } from '../procurements/procurement.service.js';
import { assertCanEdit } from '../utils/access.js';
import { HttpError } from '../utils/http-error.js';
import { buildPagination } from '../utils/pagination.js';
import * as contractServices from './contract.service.js';

/**
 * Contracts controller.
 * A contract belongs to a procurement; whoever may edit the procurement may
 * manage its contracts.
 */

// Loads a contract or throws 404
const findContractOrFail = async (contractId: number) => {
    const contract = await contractServices.getContractRowService(contractId);
    if (!contract) throw new HttpError(404, 'Contract not found');
    return contract;
};

// GET /api/contracts
export const listContracts = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, ContractQuerySchema);
    const { total, rows } = await contractServices.listContractsService(query);
    return c.json({ success: true, data: rows, pagination: buildPagination(query.page, query.limit, total) });
};

// GET /api/contracts/:id
export const getContract = async (c: Context<AppEnv>) => {
    const contractId = validateIdParam(c, 'id');
    const contract = await contractServices.getContractDetailService(contractId);
    if (!contract) throw new HttpError(404, 'Contract not found');
    return c.json({ success: true, data: contract });
};

// POST /api/contracts
export const createContract = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateContractSchema);
    const user = c.get('user');

    const procurement = await getProcurementRowService(input.procurement_id);
    if (!procurement) throw new HttpError(400, 'procurement_id does not match an existing procurement');
    assertCanEdit(user, procurement.owner_id);

    const contractId = await contractServices.createContractService(input, user.user_id);
    const contract = await contractServices.getContractDetailService(contractId);
    return c.json({ success: true, message: 'Contract created', data: contract }, 201);
};

// PUT /api/contracts/:id
export const updateContract = async (c: Context<AppEnv>) => {
    const contractId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateContractSchema);
    const user = c.get('user');

    const contract = await findContractOrFail(contractId);
    assertCanEdit(user, contract.owner_id);

    await contractServices.updateContractService(contract, input, user.user_id);
    const updated = await contractServices.getContractDetailService(contractId);
    return c.json({ success: true, message: 'Contract updated', data: updated });
};

// DELETE /api/contracts/:id
export const deleteContract = async (c: Context<AppEnv>) => {
    const contractId = validateIdParam(c, 'id');
    const user = c.get('user');

    const contract = await findContractOrFail(contractId);
    assertCanEdit(user, contract.owner_id);

    await contractServices.deleteContractService(contract, user.user_id);
    return c.json({ success: true, message: 'Contract deleted' });
};
