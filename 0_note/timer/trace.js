function foo() {
  function bar() {
    console.trace();
  }
  bar();
}
foo();

function a1() {
  a2();
}
function a2() {
  a3();
}
function a3() {
  a4();
}
function a4() {
  a5();   
}
function a5() {
  console.trace();
}
a1();
