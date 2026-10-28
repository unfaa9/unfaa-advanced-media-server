import express from 'express';
import uploadImage, { uploadMulter } from '../../middlewares/uploadImage';
import validateRequest from '../../middlewares/validateRequest';
import { fileUploadController } from './fileUpload.controller';
import { fileUploadValidation } from './fileUpload.validation';

const router = express.Router();
router.get('/', fileUploadController.getAllFiles);
router.post(
  '/',
  uploadMulter.single('image'),
  uploadImage,
  fileUploadController.uploadSingleFile
);
router.delete(
  '/',
  validateRequest(fileUploadValidation.deleteValidationSchema),
  fileUploadController.deleteFile
);

export const fileUploadRoutes = router;
