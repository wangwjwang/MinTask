/**
 * components/field-picker
 * ---------------------------------------------------------------------------
 * 枚举选择行。新建任务页、编辑页、模板配置里一共有十几个枚举字段，
 * 每个都手写一遍 picker 绑定既啰嗦又容易漏掉某一处的取值校验。
 *
 * 用法：
 *   <field-picker
 *     label="任务分类" required
 *     value="{{form.category}}"
 *     options="{{categoryOptions}}"
 *     data-field="category"
 *     bind:change="onFieldChange"
 *   />
 * ---------------------------------------------------------------------------
 */

Component({
  options: { addGlobalClass: true },

  properties: {
    /** 左侧标签文案 */
    label: { type: String, value: '' },
    /** 当前值（字符串枚举） */
    value: { type: String, value: '' },
    /** 选项数组（字符串数组） */
    options: { type: Array, value: [] },
    /** 是否必填，仅影响标签上的红星 */
    required: { type: Boolean, value: false },
    /** 未选择时的占位文案 */
    placeholder: { type: String, value: '请选择' },
    /**
     * 回传标识。父组件用 data-field="category" 的方式无法在自定义组件上生效，
     * 所以这里显式声明一个 field 属性，change 事件里带回去。
     */
    field: { type: String, value: '' },
  },

  data: {
    /** picker 的索引，-1 表示未选中 */
    index: -1,
  },

  observers: {
    'value, options': function (value, options) {
      const i = (options || []).indexOf(value);
      if (i !== this.data.index) {
        this.setData({ index: i });
      }
    },
  },

  methods: {
    onChange(e) {
      const i = Number(e.detail.value);
      const picked = this.data.options[i];
      if (picked === undefined) return;
      this.triggerEvent('change', { field: this.data.field, value: picked, index: i });
    },
  },
});
