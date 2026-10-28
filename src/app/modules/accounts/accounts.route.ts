import express from 'express';
import { requireScope } from '../../middlewares/apiKeyAuth';
import { accountsController } from './accounts.controller';

const router = express.Router();

router.put('/:ref', requireScope('accounts:write'), accountsController.upsert);
router.get('/:ref', requireScope('accounts:read'), accountsController.getOne);
router.delete('/:ref', requireScope('accounts:write'), accountsController.remove);

export const accountsRoutes = router;
