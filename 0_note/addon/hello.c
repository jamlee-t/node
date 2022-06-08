// https://fsp1yjl.github.io/2017/07/03/%E5%9C%A8node-js%E9%A1%B9%E7%9B%AE%E4%B8%AD%E4%BD%BF%E7%94%A8c-addon/

#include <node.h>
#include <v8.h>
using namespace v8;
void Method(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    args.GetReturnValue().Set(String::NewFromUtf8(isolate, "world"));
}
// 模块初始化函数，这里模块中创建一个名叫的hello的方法
void init(Local<Object> exports) {
    /*
        // 这样hello将成为导出模块的一个属性
        //如果想设置Method作为到处模块本身，可以这样写：
        void Init(Local<Object> exports, Local<Object> module) {
            NODE_SET_METHOD(module, "exports", CreateObject);
        }
    */
    NODE_SET_METHOD(exports, "hello", Method);
}
   
//NODE_MODULE 是一个宏，export一个名叫addon的模块，init为初始化函数名
NODE_MODULE(addon, init)