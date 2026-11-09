import { z } from 'zod';
import { baseSchema } from './common.js';

// course patch: single-choice questions that gate a lesson
export type LessonQuestion = {
  prompt: string;
  options: string[];
  answer: number;
  hint?: string;
};

// course patch: what a challenge asks for, which the Challenge tab ticks as each one passes
export type LessonRequirement = {
  id: string;
  label: string;
};

const questionSchema: z.ZodType<LessonQuestion> = z
  .object({
    prompt: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    answer: z.number().int().nonnegative(),
    hint: z.string().min(1).optional().describe('Where to look, shown after a wrong answer.'),
  })
  .strict()
  .refine((question) => question.answer < question.options.length, {
    message: '`answer` must be the index of one of the options.',
    path: ['answer'],
  });

const requirementSchema: z.ZodType<LessonRequirement> = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'Use lowercase letters, digits and dashes.'),
    label: z.string().min(1).describe('What the student sees once it works, not the code to write.'),
  })
  .strict();

export const lessonSchema = baseSchema.extend({
  type: z.literal('lesson'),
  challenge: z.boolean().optional().describe('Marks a lesson as a completion-gated challenge.'),
  questions: z
    .array(questionSchema)
    .min(1)
    .optional()
    .describe('Single-choice questions the student must answer correctly to complete the lesson.'),
  requirements: z
    .array(requirementSchema)
    .min(1)
    .optional()
    .describe("The challenge's requirements, each reported by its check as it passes."),
  scope: z.string().optional().describe('A prefix that all file paths must match to be visible in the file tree.'),
  hideRoot: z
    .boolean()
    .optional()
    .describe('If set to false, `/` is shown at the top of the file tree. Defaults to true.'),
});

export type LessonSchema = z.infer<typeof lessonSchema>;
