import { logFunctionName } from "../formTools/formTools.js";
toastr.options = {
    "closeButton": true,
    "debug": false,
    "newestOnTop": true,
    "progressBar": true,
    "positionClass": "toast-top-right",
    "preventDuplicates": false,
    "onclick": null,
    "showDuration": "300",
    "hideDuration": "1000",
    "timeOut": "2500",
    "extendedTimeOut": "1000",
    "showEasing": "swing",
    "hideEasing": "linear",
    "showMethod": "fadeIn",
    "hideMethod": "fadeOut"
  };
 

export function showToast(type, message) {
    logFunctionName('showToast');
    if (type === 'success') {
        toastr.success(message);
    }
    else if (type === 'error') {
        const previousOptions = {...toastr.options};
        toastr.options.timeOut = '10000';
        toastr.error(message);
        toastr.options = previousOptions;
    } 
    else if (type === 'info') {
        toastr.info(message);
    } 
    else if (type === 'warning') {
        toastr.warning(message);
    }

}
export function showToastInContainer(parent,type,message){
    const previousOptions = {...toastr.options};

    const customToastContainer = document.createElement('div');
    customToastContainer.id = 'custom-toast-container';
    customToastContainer.classList.add('toast-container', 'toast-top-right');
    parent.appendChild(customToastContainer);
    toastr.options.containerId= customToastContainer.id;

    showToast(type,message);

    toastr.options = previousOptions;
}