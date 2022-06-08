#pragma once

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include "aliased_buffer.h"
#include "v8-profiler.h"

#include <uv.h>

#include <limits>
#include <queue>
#include <stack>
#include <string>
#include <unordered_map>

namespace node {

// JAMLEE: 注意到是否有的子类没有 MemoryInfo 函数的。所以要搜 SET_MEMORY_INFO_NAME
// Set the node name of a MemoryRetainer to klass
#define SET_MEMORY_INFO_NAME(Klass)                                            \
  inline std::string MemoryInfoName() const override { return #Klass; }

// Set the self size of a MemoryRetainer to the stack-allocated size of a
// certain class
#define SET_SELF_SIZE(Klass)                                                   \
  inline size_t SelfSize() const override { return sizeof(Klass); }

// JAMLEE: 注意到是否有的子类没有 MemoryInfo 函数的。所以要搜 SET_NO_MEMORY_INFO
// Used when there is no additional fields to track
#define SET_NO_MEMORY_INFO()                                                   \
  inline void MemoryInfo(node::MemoryTracker* tracker) const override {}

class MemoryTracker;
class MemoryRetainerNode;

namespace crypto {
class NodeBIO;
}

class CleanupHookCallback;

/* Example:
 *
 * class ExampleRetainer : public MemoryRetainer {
 *   public:
 *     // Or use SET_NO_MEMORY_INFO() when there is no additional fields
 *     // to track.
 *     void MemoryInfo(MemoryTracker* tracker) const override {
 *       // Node name and size comes from the MemoryInfoName and SelfSize of
 *       // AnotherRetainerClass
 *       tracker->TrackField("another_retainer", another_retainer_);
 *
 *       // Add non_pointer_retainer as a separate node into the graph
 *       // and track its memory information recursively.
 *       // Note that we need to make sure its size is not accounted in
 *       // ExampleRetainer::SelfSize().
 *       tracker->TrackField("non_pointer_retainer", &non_pointer_retainer_);
 *
 *       // Specify node name and size explicitly
 *       tracker->TrackFieldWithSize("internal_member",
 *                                   internal_member_.size(),
 *                                   "InternalClass");
 *       // Node name falls back to the edge name,
 *       // elements in the container appear as grandchildren nodes
 *       tracker->TrackField("vector", vector_);
 *       // Node name and size come from the JS object
 *       tracker->TrackField("target", target_);
 *     }
 *
 *     // Or use SET_MEMORY_INFO_NAME(ExampleRetainer)
 *     std::string MemoryInfoName() const override {
 *       return "ExampleRetainer";
 *     }
 *
 *     // Classes that only want to return its sizeof() value can use the
 *     // SET_SELF_SIZE(Class) macro instead.
 *     size_t SelfSize() const override {
 *       // We need to exclude the size of non_pointer_retainer so that
 *       // we can track it separately in ExampleRetainer::MemoryInfo().
 *       return sizeof(ExampleRetainer) - sizeof(NonPointerRetainerClass);
 *     }
 *
 *     // Note: no need to implement these two methods when implementing
 *     // a BaseObject or an AsyncWrap class
 *     bool IsRootNode() const override { return !wrapped_.IsWeak(); }
 *     v8::Local<v8::Object> WrappedObject() const override {
 *       return node::PersistentToLocal::Default(wrapped_);
 *     }
 *
 *   private:
 *     AnotherRetainerClass* another_retainer_;
 *     NonPointerRetainerClass non_pointer_retainer;
 *     InternalClass internal_member_;
 *     std::vector<uv_async_t> vector_;
 *     v8::Global<Object> target_;
 *
 *     v8::Global<Object> wrapped_;
 * }
 *
 * This creates the following graph:
 *   Node / ExampleRetainer
 *    |> another_retainer :: Node / AnotherRetainerClass
 *    |> internal_member :: Node / InternalClass
 *    |> vector :: Node / vector (elements will be grandchildren)
 *        |> [1] :: Node / uv_async_t (uv_async_t has predefined names)
 *        |> [2] :: Node / uv_async_t
 *        |> ...
 *    |> target :: TargetClass (JS class name of the target object)
 *    |> wrapped :: WrappedClass (JS class name of the wrapped object)
 *        |> wrapper :: Node / ExampleRetainer (back reference)
 */
// JAMLEE: MemoryRetainer 没有继承其他类，这个类就是最顶级的类。
// 参考：https://github.com/nodejs/node/blob/master/src/README.md#classes-associated-with-javascript-objects

// 1. 函数后面的 const:
/*
给隐含的this指针加const，表示这个this指向的东西是const的，也就是说这个函数中无法改动数据成员了。const是一种保证，告诉你这个成员不会改变对象的状态。
声明一个成员函数的时候用const关键字是用来说明这个函数是 “只读(read-only)”函数，也就是说明这个函数不会修改任何数据成员(object)。 为了声明一个const成员函数， 把const关键字放在函数括号的后面。声明和定义的时候都应该放const关键字。
*/

// 2. 函数后面带 = 0
/*
纯虚函数是在声明虚函数时被“初始化”为0的函数。声明纯虚函数的一般形式是 virtual 函数类型 函数名 (参数表列) =0;
①纯虚函数没有函数体；
②最后面的“=0”并不表示函数返回值为0，它只起形式上的作用，告诉编译系统“这是纯虚函数”; 
③这是一个声明语句，最后应有分号。

多态（polymorphism）是面向对象编程语言的一大特点，而虚函数是实现多态的机制。其核心理念就是通过基类访问派生类定义的函数。多态性使得程序调用的函数是在运行时动态确定的，而不是在编译时静态确定的。使用一个基类类型的指针或者引用，来指向子类对象，进而调用由子类复写的个性化的虚函数，这是C++实现多态性的一个最经典的场景。
虚函数，在类成员方法的声明（不是定义）语句前加“virtual”, 如 virtual void func()
纯虚函数，在虚函数后加“=0”，如 virtual void func()=0
对于虚函数，子类可以（也可以不）重新定义基类的虚函数，该行为称之为复写Override。
对于纯虚函数，子类必须提供纯虚函数的个性化实现。
在派生子类中对虚函数和纯虚函数的个性化实现，都体现了“多态”特性。但区别是：
子类如果不提供虚函数的实现，将会自动调用基类的缺省虚函数实现，作为备选方案；
子类如果不提供纯虚函数的实现，编译将会失败。尽管在基类中可以给出纯虚函数的实现，但无法通过指向子类对象的基类类型指针来调用该纯虚函数，也即不能作为子类相应纯虚函数的备选方案。（纯虚函数在基类中的实现跟多态性无关，它只是提供了一种语法上的便利，在变化多端的应用场景中留有后路。）

#include<iostream>

using namespace std;

class Father {
   public:
   virtual void foo()=0;
};

class Son:public Father {
  // Nothing here
};

class Grand_Son:public Son {
    public:
    void foo() {
        cout<<"\nFunction foo From Grand_Son\n";
    }
};

int main() {
   Grand_Son x;
   x.foo();
}
*/

// 3. 函数后面的 override 关键字
/*
override关键字表示重写父类的虚函数。
1. 表示重写了父类的函数增加可读性 2. 编译器会检查重写的函数与父类的虚函数是否一致
https://en.cppreference.com/w/cpp/language/override

class Base
{
public:
    virtual void Test(int number) const;
 
};
 
class Obama : public Base
{
public:
    void Test(int number) const override;
}
 
void Base::Test(int number) const
{
    setAge(number);
}
 
void Obama ::Test(int number) const
{
    setAge(number + 1);
}
*/

// 4. default 
/*
C++11 标准引入了一个新特性："=default"函数。程序员只需在函数声明后加上“=default;”，就可将该函数声明为 "=default"函数，编译器将为显式声明的 "=default"函数自动生成函数体。
"=default"函数特性仅适用于类的特殊成员函数，且该特殊成员函数没有默认参数；
"=default"函数既可以在类体里（inline）定义，也可以在类体外（out-of-line）定义。

class X { 
public: 
    X() = default; //该函数比用户自己定义的默认构造函数获得更高的代码效率
    X(int i) { 
        a = i; 
    }
private: 
    int a; 
}; 
 
X obj;
 
// "=default"函数特性仅适用于类的特殊成员函数，且该特殊成员函数没有默认参数。
class X1{
public:
    int f() = default;      // err , 函数 f() 非类 X 的特殊成员函数
    X1(int, int) = default;  // err , 构造函数 X1(int, int) 非 X 的特殊成员函数
    X1(int = 1) = default;   // err , 默认构造函数 X1(int=1) 含有默认参数
};
 
// "=default"函数既可以在类体里（inline）定义，也可以在类体外（out-of-line）定义。
class X2{
public:
    X2() = default; //Inline defaulted 默认构造函数
    X2(const X&);
    X2& operator = (const X&);
    ~X2() = default;  //Inline defaulted 析构函数
};
 
X2::X2(const X&) = default;  //Out-of-line defaulted 拷贝构造函数
X2& X2::operator= (const X2&) = default;   //Out-of-line defaulted  拷贝赋值操作符
*/
class MemoryRetainer {
 public:
  virtual ~MemoryRetainer() = default;

  // Subclasses should implement these methods to provide information
  // for the V8 heap snapshot generator.
  // The MemoryInfo() method is assumed to be called within a context
  // where all the edges start from the node of the current retainer,
  // and point to the nodes as specified by tracker->Track* calls.
  virtual void MemoryInfo(MemoryTracker* tracker) const = 0;
  
  // JAMLEE: 例如 AsyncWrap 类中有实现此纯虚函数。
  virtual std::string MemoryInfoName() const = 0;

  virtual size_t SelfSize() const = 0;

  // JAMLEE: 获取当前类对象关联的 v8 对象
  virtual v8::Local<v8::Object> WrappedObject() const {
    return v8::Local<v8::Object>();
  }

  virtual bool IsRootNode() const { return false; }
};


// JAMLEE: MemoryInfo 的参数 MemoryTracker
class MemoryTracker {
 public:
  // Used to specify node name and size explicitly
  inline void TrackFieldWithSize(const char* edge_name,
                                 size_t size,
                                 const char* node_name = nullptr);
  // Shortcut to extract the underlying object out of the smart pointer
  template <typename T>
  inline void TrackField(const char* edge_name,
                         const std::unique_ptr<T>& value,
                         const char* node_name = nullptr);

  // For containers, the elements will be graphed as grandchildren nodes
  // if the container is not empty.
  // By default, we assume the parent count the stack size of the container
  // into its SelfSize so that will be subtracted from the parent size when we
  // spin off a new node for the container.
  // TODO(joyeecheung): use RTTI to retrieve the class name at runtime?
  template <typename T, typename Iterator = typename T::const_iterator>
  inline void TrackField(const char* edge_name,
                         const T& value,
                         const char* node_name = nullptr,
                         const char* element_name = nullptr,
                         bool subtract_from_self = true);
  template <typename T>
  inline void TrackField(const char* edge_name,
                         const std::queue<T>& value,
                         const char* node_name = nullptr,
                         const char* element_name = nullptr);
  template <typename T, typename U>
  inline void TrackField(const char* edge_name,
                         const std::pair<T, U>& value,
                         const char* node_name = nullptr);

  // For the following types, node_name will be ignored and predefined names
  // will be used instead. They are only in the signature for template
  // expansion.
  inline void TrackField(const char* edge_name,
                         const MemoryRetainer& value,
                         const char* node_name = nullptr);
  inline void TrackField(const char* edge_name,
                         const MemoryRetainer* value,
                         const char* node_name = nullptr);
  template <typename T>
  inline void TrackField(const char* edge_name,
                         const std::basic_string<T>& value,
                         const char* node_name = nullptr);
  template <typename T,
            typename test_for_number = typename std::
                enable_if<std::numeric_limits<T>::is_specialized, bool>::type,
            typename dummy = bool>
  inline void TrackField(const char* edge_name,
                         const T& value,
                         const char* node_name = nullptr);
  template <typename T>
  void TrackField(const char* edge_name,
                  const v8::Eternal<T>& value,
                  const char* node_name);
  template <typename T>
  inline void TrackField(const char* edge_name,
                         const v8::PersistentBase<T>& value,
                         const char* node_name = nullptr);
  template <typename T>
  inline void TrackField(const char* edge_name,
                         const v8::Local<T>& value,
                         const char* node_name = nullptr);
  template <typename T>
  inline void TrackField(const char* edge_name,
                         const MallocedBuffer<T>& value,
                         const char* node_name = nullptr);
  // We do not implement CleanupHookCallback as MemoryRetainer
  // but instead specialize the method here to avoid the cost of
  // virtual pointers.
  // TODO(joyeecheung): do this for BaseObject and remove WrappedObject()
  void TrackField(const char* edge_name,
                  const CleanupHookCallback& value,
                  const char* node_name = nullptr);
  inline void TrackField(const char* edge_name,
                         const uv_buf_t& value,
                         const char* node_name = nullptr);
  inline void TrackField(const char* edge_name,
                         const uv_timer_t& value,
                         const char* node_name = nullptr);
  inline void TrackField(const char* edge_name,
                         const uv_async_t& value,
                         const char* node_name = nullptr);
  template <class NativeT, class V8T>
  inline void TrackField(const char* edge_name,
                         const AliasedBufferBase<NativeT, V8T>& value,
                         const char* node_name = nullptr);

  // JAMLEE: 函数参数默认值
  // 我们可以赋予函数参数默认值。所谓默认值就是在调用时，可以不写某些参数的值，编译器会自动把默认值传递给调用语句中。默认值可以在声明或定义中设置；也可在声明或定义时都设置，都设置时要求默认值是相同的。
  // Put a memory container into the graph, create an edge from
  // the current node if there is one on the stack.
  inline void Track(const MemoryRetainer* retainer,
                    const char* edge_name = nullptr);

  // Useful for parents that do not wish to perform manual
  // adjustments to its `SelfSize()` when embedding retainer
  // objects inline.
  // Put a memory container into the graph, create an edge from
  // the current node if there is one on the stack - there should
  // be one, of the container object which the current field is part of.
  // Reduce the size of memory from the container so as to avoid
  // duplication in accounting.
  inline void TrackInlineField(const MemoryRetainer* retainer,
                               const char* edge_name = nullptr);

  inline v8::EmbedderGraph* graph() { return graph_; }
  inline v8::Isolate* isolate() { return isolate_; }

  inline explicit MemoryTracker(v8::Isolate* isolate,
                                v8::EmbedderGraph* graph)
    : isolate_(isolate), graph_(graph) {}

 private:
  typedef std::unordered_map<const MemoryRetainer*, MemoryRetainerNode*>
      NodeMap;

  inline MemoryRetainerNode* CurrentNode() const;
  inline MemoryRetainerNode* AddNode(const MemoryRetainer* retainer,
                                     const char* edge_name = nullptr);
  inline MemoryRetainerNode* PushNode(const MemoryRetainer* retainer,
                                      const char* edge_name = nullptr);
  inline MemoryRetainerNode* AddNode(const char* node_name,
                                     size_t size,
                                     const char* edge_name = nullptr);
  inline MemoryRetainerNode* PushNode(const char* node_name,
                                      size_t size,
                                      const char* edge_name = nullptr);
  inline void PopNode();

  v8::Isolate* isolate_;
  v8::EmbedderGraph* graph_;
  std::stack<MemoryRetainerNode*> node_stack_;
  NodeMap seen_;
};

}  // namespace node

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS
