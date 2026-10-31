import { z } from 'zod';

const deleteValidationSchema = z.object({
  body: z.object({
    urls: z.array(
      z.string({
        error: issue =>
          issue.input === undefined ? 'url is required ' : undefined,
      })
    ),
  }),
});
export const fileUploadValidation = {
  deleteValidationSchema,
};
