<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import api from '../../api.js';
import { isPreviewableImageAttachment } from './attachment-utils.js';

const props = defineProps({
  attachment: {
    type: Object,
    required: true
  }
});

const previewOpen = ref(false);
const previewEl = ref(null);
const imageFailed = ref(false);
const isImage = computed(() => isPreviewableImageAttachment(props.attachment));
const displayName = computed(() => props.attachment?.name || '附件');
const openOriginalLabel = computed(() => `打开原图：${displayName.value}`);

function openPreview() {
  if (!isImage.value || imageFailed.value) {
    return;
  }

  previewOpen.value = true;
  nextTick(() => previewEl.value?.focus());
}

function closePreview() {
  previewOpen.value = false;
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    closePreview();
  }
}

watch(previewOpen, (open) => {
  const method = open ? 'addEventListener' : 'removeEventListener';
  window[method]('keydown', handleKeydown);
});

watch(
  () => props.attachment?.url,
  () => {
    imageFailed.value = false;
  }
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div class="message-attachment" :class="{ 'message-attachment--image': isImage }">
    <template v-if="isImage">
      <button
        v-if="!imageFailed"
        type="button"
        class="message-attachment__image-button"
        :aria-label="`预览图片：${displayName}`"
        @click="openPreview"
      >
        <img
          class="message-attachment__image"
          :src="attachmentUrl"
          :alt="displayName"
          loading="lazy"
          @error="imageFailed = true"
        />
      </button>
      <a
        v-else
        :href="attachmentUrl"
        target="_blank"
        rel="noreferrer"
        class="chat-bubble__attachment message-attachment__file"
      >
        {{ displayName }}
      </a>

      <Teleport to="body">
        <div
          v-if="previewOpen"
          ref="previewEl"
          class="image-preview-overlay"
          role="dialog"
          aria-modal="true"
          :aria-label="`图片预览：${displayName}`"
          tabindex="-1"
          @click.self="closePreview"
        >
          <div class="image-preview-overlay__toolbar">
            <span class="image-preview-overlay__title">{{ displayName }}</span>
            <a
              class="image-preview-overlay__action"
              :href="attachmentUrl"
              target="_blank"
              rel="noreferrer"
              :aria-label="openOriginalLabel"
            >
              打开原图
            </a>
            <button type="button" class="image-preview-overlay__close" @click="closePreview">
              关闭
            </button>
          </div>
          <img class="image-preview-overlay__image" :src="attachmentUrl" :alt="displayName" />
        </div>
      </Teleport>
    </template>

    <a
      v-else
      :href="attachmentUrl"
      target="_blank"
      rel="noreferrer"
      class="chat-bubble__attachment message-attachment__file"
    >
      {{ displayName }}
    </a>
  </div>
</template>
