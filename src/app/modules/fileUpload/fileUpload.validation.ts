import { z } from 'zod';

const deleteValidationSchema = z.object({
  body: z.object({
    urls: z.array(z.string({ required_error: 'url is required ' })),
  }),
});
export const fileUploadValidation = {
  deleteValidationSchema,
};
