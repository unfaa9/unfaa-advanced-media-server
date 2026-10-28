import express from 'express';
import { requireScope } from '../../middlewares/apiKeyAuth';
import { filesController } from './files.controller';

const router = express.Router();

router.post('/', requireScope('files:write'), filesController.upload);
router.get('/', requireScope('files:read'), filesController.list);
router.post('/confirm', requireScope('files:write'), filesController.confirmBatch);
router.post(
  '/delete-by-owner',
  requireScope('files:delete'),
  filesController.deleteByOwner
);
router.get('/:id', requireScope('files:read'), filesController.getOne);
router.delete('/:id', requireScope('files:delete'), filesController.remove);
router.post('/:id/confirm', requireScope('files:write'), filesController.confirm);
router.post('/:id/restore', requireScope('files:delete'), filesController.restore);
router.post('/:id/refs', requireScope('files:write'), filesController.addRef);
router.delete('/:id/refs', requireScope('files:delete'), filesController.removeRef);

export const filesRoutes = router;
