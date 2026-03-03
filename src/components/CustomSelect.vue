<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ChevronDown, Check } from 'lucide-vue-next'

interface Option {
  value: string;
  label: string;
}

defineOptions({
  name: 'CustomSelect'
})

const props = defineProps<{
  modelValue: string;
  options: Option[];
  placeholder?: string;
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const isOpen = ref(false)
const containerRef = ref<HTMLElement | null>(null)

const selectedLabel = computed(() => {
  const option = props.options.find((o: Option) => o.value === props.modelValue)
  return option ? option.label : (props.placeholder || 'Select...')
})

function toggleDropdown() {
  isOpen.value = !isOpen.value
}

function selectOption(value: string) {
  emit('update:modelValue', value)
  isOpen.value = false
}

function closeDropdown(e: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', closeDropdown)
})

onUnmounted(() => {
  document.removeEventListener('click', closeDropdown)
})
</script>

<script lang="ts">
import { defineComponent } from 'vue'
export default defineComponent({
  name: 'CustomSelect'
})
</script>

<template>
  <div ref="containerRef" class="relative">
    <button
      type="button"
      @click="toggleDropdown"
      class="w-full flex items-center justify-between px-3 py-2 bg-white border border-slate-300 rounded-lg shadow-sm text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500"
    >
      <span class="truncate">{{ selectedLabel }}</span>
      <ChevronDown :size="16" class="text-slate-400 transition-transform duration-200" :class="{ 'rotate-180': isOpen }" />
    </button>

    <Transition
      enter-active-class="transition ease-out duration-100"
      enter-from-class="transform opacity-0 scale-95"
      enter-to-class="transform opacity-100 scale-100"
      leave-active-class="transition ease-in duration-75"
      leave-from-class="transform opacity-100 scale-100"
      leave-to-class="transform opacity-0 scale-95"
    >
      <div
        v-if="isOpen"
        class="absolute z-50 w-full mt-1 bg-white rounded-lg shadow-lg border border-slate-100 py-1 max-h-60 overflow-auto focus:outline-none"
      >
        <button
          v-for="option in options"
          :key="option.value"
          @click="selectOption(option.value)"
          class="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-sky-50 hover:text-sky-700 flex items-center justify-between group"
        >
          <span :class="{ 'font-semibold': modelValue === option.value }">{{ option.label }}</span>
          <Check v-if="modelValue === option.value" :size="16" class="text-sky-600" />
        </button>
      </div>
    </Transition>
  </div>
</template>
