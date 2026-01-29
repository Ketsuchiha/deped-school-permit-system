<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ChevronDown, Check } from 'lucide-vue-next'

const props = defineProps({
  modelValue: [String, Number],
  options: {
    type: Array,
    default: () => []
  },
  placeholder: {
    type: String,
    default: 'Select option'
  },
  error: Boolean
})

const emit = defineEmits(['update:modelValue'])

const isOpen = ref(false)
const containerRef = ref(null)

const selectedLabel = computed(() => {
  const selected = props.options.find(opt => opt.value === props.modelValue)
  return selected ? selected.label : props.placeholder
})

function toggle() {
  isOpen.value = !isOpen.value
}

function select(option) {
  emit('update:modelValue', option.value)
  isOpen.value = false
}

function close(e) {
  if (containerRef.value && !containerRef.value.contains(e.target)) {
    isOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', close)
})

onUnmounted(() => {
  document.removeEventListener('click', close)
})
</script>

<template>
  <div class="relative" ref="containerRef">
    <button
      type="button"
      @click="toggle"
      class="w-full flex items-center justify-between px-3 py-2 rounded-lg border bg-white transition-all duration-200 outline-none focus:ring-2 focus:ring-sky-500/20"
      :class="[
        isOpen ? 'border-sky-500 ring-2 ring-sky-500/20' : 'border-slate-300 hover:border-slate-400',
        error ? 'border-red-500' : ''
      ]"
    >
      <span class="truncate" :class="modelValue ? 'text-slate-800' : 'text-slate-400'">
        {{ selectedLabel }}
      </span>
      <ChevronDown
        :size="18"
        class="text-slate-400 transition-transform duration-200 flex-shrink-0 ml-2"
        :class="{ 'rotate-180': isOpen }"
      />
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="transform scale-95 opacity-0"
      enter-to-class="transform scale-100 opacity-100"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="transform scale-100 opacity-100"
      leave-to-class="transform scale-95 opacity-0"
    >
      <div
        v-if="isOpen"
        class="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-xl max-h-60 overflow-auto"
      >
        <ul class="py-1">
          <li
            v-for="option in options"
            :key="option.value"
            @click="select(option)"
            class="px-3 py-2 text-sm text-slate-700 hover:bg-sky-50 hover:text-sky-700 cursor-pointer flex items-center justify-between transition-colors"
            :class="{ 'bg-sky-50 text-sky-700 font-medium': modelValue === option.value }"
          >
            <span class="truncate">{{ option.label }}</span>
            <Check v-if="modelValue === option.value" :size="16" class="text-sky-600 flex-shrink-0 ml-2" />
          </li>
          <li v-if="options.length === 0" class="px-3 py-2 text-sm text-slate-400 text-center italic">
            No options available
          </li>
        </ul>
      </div>
    </Transition>
  </div>
</template>
