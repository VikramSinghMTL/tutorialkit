import { useStore } from '@nanostores/react';
import { WorkspacePanel } from '@tutorialkit/react';
import type { Lesson } from '@tutorialkit/types';
import { useEffect } from 'react';
// course patch: the dialog has its own module, so this client island doesn't also bundle the TopBar and HeadTags.
import { Dialog } from 'tutorialkit:override-dialog';
import { themeStore } from '../stores/theme-store.js';
import { tutorialStore } from './webcontainer.js';

interface Props {
  lesson: Lesson;
}

export function WorkspacePanelWrapper({ lesson }: Props) {
  const theme = useStore(themeStore);

  useEffect(() => {
    tutorialStore.setLesson(lesson);
  }, [lesson]);

  if (import.meta.env.SSR || !tutorialStore.lesson) {
    tutorialStore.setLesson(lesson, { ssr: import.meta.env.SSR });
  }

  return <WorkspacePanel dialog={Dialog} tutorialStore={tutorialStore} theme={theme} />;
}
